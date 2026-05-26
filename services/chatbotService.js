'use strict';

const path       = require('path');
const fs         = require('fs');
const Anthropic  = require('@anthropic-ai/sdk');
const db         = require('../database');
const whatsappService = require('./whatsappService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SESSION_TIMEOUT_MIN = 30;
const FOTO_UPLOAD_DIR     = path.join(__dirname, '../public/uploads/solicitacoes');

const CANCEL_KEYWORDS = new Set(['cancelar', 'cancel', 'sair', 'reiniciar', 'restart', 'início', 'inicio']);
const START_KEYWORDS  = ['oi', 'olá', 'ola', 'abastecimento', 'abastecer', 'solicitar', 'inicio', 'início'];

// Tipos de veículo que usam horímetro (replicado de vehicleRules.js)
const TIPOS_HORIMETRO = new Set([
    'Motoniveladora', 'Pá Carregadeira', 'Retroescavadeira', 'Rolo', 'Trator',
    'Escavadeira', 'Escavadeira + Rompedor', 'Fresadora', 'Trator Esteira',
    'Bitruck', 'Caminhão Pipa', 'Caminhão Tanque', 'Caminhão Carroceria', 'Cavalo',
    'Caçamba Bitruck', 'Caçamba Toco', 'Caçamba Traçado', 'Caçamba Truckado',
    'Caminhão', 'Caçamba',
]);

function veiculoUsaHorimetro(tipo) {
    return TIPOS_HORIMETRO.has(tipo);
}

// ─── SESSION HELPERS ──────────────────────────────────────────────────────────

async function getSession(phone) {
    const [rows] = await db.query(
        `SELECT * FROM whatsapp_chatbot_sessions
         WHERE phone_number = ? AND step NOT IN ('concluido', 'cancelado')
           AND last_activity >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
         ORDER BY created_at DESC LIMIT 1`,
        [phone, SESSION_TIMEOUT_MIN]
    );
    if (!rows.length) return null;
    const s = rows[0];
    if (typeof s.session_data === 'string') {
        try { s.session_data = JSON.parse(s.session_data); } catch (_) { s.session_data = {}; }
    }
    s.session_data = s.session_data || {};
    return s;
}

async function createSession(phone, employeeId, employeeName) {
    const [result] = await db.query(
        `INSERT INTO whatsapp_chatbot_sessions (phone_number, employee_id, employee_name, step, session_data)
         VALUES (?, ?, ?, 'veiculo', '{}')`,
        [phone, employeeId, employeeName]
    );
    return {
        id:             result.insertId,
        phone_number:   phone,
        employee_id:    employeeId,
        employee_name:  employeeName,
        step:           'veiculo',
        session_data:   {},
        foto_painel_path: null,
    };
}

async function updateSession(sessionId, step, sessionData, fotoPainelPath) {
    const params = [step, JSON.stringify(sessionData || {})];
    let q = 'UPDATE whatsapp_chatbot_sessions SET step = ?, session_data = ?, last_activity = NOW()';
    if (fotoPainelPath !== undefined) {
        q += ', foto_painel_path = ?';
        params.push(fotoPainelPath);
    }
    q += ' WHERE id = ?';
    params.push(sessionId);
    await db.query(q, params);
}

async function cancelSession(sessionId) {
    await db.query(
        `UPDATE whatsapp_chatbot_sessions SET step = 'cancelado' WHERE id = ?`,
        [sessionId]
    );
}

// ─── EMPLOYEE IDENTIFICATION ──────────────────────────────────────────────────

async function identificarFuncionario(phone) {
    const limpo   = phone.replace(/\D/g, '');
    const semPais = limpo.length > 11 ? limpo.slice(2) : limpo;
    const comPais = limpo.length <= 11 ? '55' + limpo : limpo;

    const [rows] = await db.query(
        `SELECT id, nome FROM employees WHERE status = 'ativo'
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(contato,' ',''),'-',''),'(',''),')',''),'+','')
             IN (?, ?, ?)
         LIMIT 1`,
        [limpo, semPais, comPais]
    );
    return rows.length ? rows[0] : null;
}

// ─── CLAUDE API HELPERS ───────────────────────────────────────────────────────

async function claudeMatchVeiculo(input, veiculos) {
    if (!veiculos.length) return null;
    const lista = veiculos.map(v =>
        `ID:${v.id} | Placa:${v.placa} | Frota:${v.registroInterno || '-'} | Modelo:${v.modelo || '-'} | Tipo:${v.tipo || '-'}`
    ).join('\n');

    const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:     'Você identifica veículos de frota. Responda SOMENTE com o número do ID do veículo mais provável. Se não houver correspondência clara, responda NENHUM. Nenhum outro texto.',
        messages:   [{ role: 'user', content: `Veículos:\n${lista}\n\nOperador digitou: "${input}"\n\nID:` }],
    });

    const raw = response.content[0].text.trim().replace(/\D/g, '');
    const id  = parseInt(raw, 10);
    return isNaN(id) ? null : id;
}

async function claudeMatchObra(input, obras) {
    if (!obras.length) return null;
    const lista = obras.map(o => `ID:${o.id} | Nome:${o.nome}`).join('\n');

    const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:     'Você identifica obras/projetos. Responda SOMENTE com o número do ID da obra mais provável. Se não houver correspondência, responda NENHUM. Nenhum outro texto.',
        messages:   [{ role: 'user', content: `Obras:\n${lista}\n\nOperador digitou: "${input}"\n\nID:` }],
    });

    const raw = response.content[0].text.trim().replace(/\D/g, '');
    const id  = parseInt(raw, 10);
    return isNaN(id) ? null : id;
}

async function claudeExtrairLeitura(input, usaHorimetro) {
    const tipo = usaHorimetro ? 'horímetro em horas' : 'odômetro em quilômetros';

    const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:     `Extraia o número de leitura de ${tipo}. Responda SOMENTE com o número (use ponto para decimal). Se não houver número claro, responda INVALIDO.`,
        messages:   [{ role: 'user', content: `"${input}"` }],
    });

    const raw = response.content[0].text.trim().replace(',', '.');
    if (raw.toUpperCase().includes('INVALIDO')) return null;
    const num = parseFloat(raw);
    return (isNaN(num) || num <= 0) ? null : num;
}

async function claudeExtrairLitragem(input) {
    const response = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:     'Extraia quantidade de litros de combustível. Se o operador disser "cheio", "tanque cheio" ou variações, responda CHEIO. Caso contrário, responda apenas o número. Se não entender, responda INVALIDO.',
        messages:   [{ role: 'user', content: `"${input}"` }],
    });

    const raw = response.content[0].text.trim().toUpperCase();
    if (raw.includes('CHEIO'))   return { litragem: null, flag_tanque_cheio: 1 };
    if (raw.includes('INVALIDO')) return null;
    const num = parseFloat(raw.replace(',', '.'));
    if (isNaN(num) || num <= 0) return null;
    return { litragem: num, flag_tanque_cheio: 0 };
}

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function salvarFotoBase64(base64Data, mimetype) {
    if (!fs.existsSync(FOTO_UPLOAD_DIR)) {
        fs.mkdirSync(FOTO_UPLOAD_DIR, { recursive: true });
    }
    const ext      = mimetype === 'image/png' ? '.png' : mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = `chatbot-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(FOTO_UPLOAD_DIR, filename), Buffer.from(base64Data, 'base64'));
    return `/uploads/solicitacoes/${filename}`;
}

// ─── SEND RESPONSE ────────────────────────────────────────────────────────────

async function responder(phone, mensagem) {
    try {
        await whatsappService.enviarMensagem(phone, 'Chatbot Frotas', 'CHATBOT_RESPOSTA', mensagem);
    } catch (err) {
        console.error('[CHATBOT] Erro ao responder para', phone, ':', err.message);
    }
}

// ─── CRIAR SOLICITAÇÃO ────────────────────────────────────────────────────────

async function criarSolicitacaoDB(session) {
    const d = session.session_data;

    const [dups] = await db.query(
        `SELECT id FROM solicitacoes_abastecimento
         WHERE veiculo_id = ? AND status IN ('PENDENTE','LIBERADO','AGUARDANDO_BAIXA')
           AND data_solicitacao >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`,
        [d.veiculo_id]
    );
    if (dups.length) {
        return { error: 'Já existe uma solicitação em andamento para este veículo nas últimas 48h.' };
    }

    const [userRows] = await db.query(
        `SELECT id FROM users WHERE employeeId = ? LIMIT 1`,
        [session.employee_id]
    );
    const usuarioId = userRows.length ? userRows[0].id : null;

    const today = new Date().toISOString().split('T')[0];

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.execute(
            `INSERT INTO solicitacoes_abastecimento
             (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel,
              litragem_solicitada, flag_tanque_cheio, flag_outros,
              horimetro_informado, odometro_informado, foto_painel_path,
              geo_latitude, geo_longitude, status, alerta_media_consumo, data_solicitacao, observacao)
             VALUES (?,?,?,NULL,?,?,?,?,0,?,?,?,0,0,'PENDENTE',0,?,?)`,
            [
                usuarioId,
                d.veiculo_id,
                d.obra_id,
                session.employee_id,
                d.tipo_combustivel,
                d.litragem || 0,
                d.flag_tanque_cheio || 0,
                d.horimetro || null,
                d.odometro  || null,
                session.foto_painel_path,
                today,
                'Solicitado via WhatsApp',
            ]
        );
        await conn.commit();

        if (global.io) {
            global.io.emit('server:sync', { targets: ['solicitacoes'] });
            global.io.emit('admin:notificacao', { tipo: 'nova_solicitacao', id: result.insertId });
        }

        return { id: result.insertId };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ─── STEP HANDLERS ────────────────────────────────────────────────────────────

async function handleVeiculo(session, from, body) {
    const [veiculos] = await db.query(
        `SELECT id, placa, registroInterno, modelo, tipo FROM vehicles WHERE status = 'Ativo' ORDER BY placa`
    );

    const veiculoId = await claudeMatchVeiculo(body, veiculos);
    if (!veiculoId) {
        await responder(from,
            `❌ Não consegui identificar o veículo com "*${body}*".\n\n` +
            `Tente com a placa completa (ex: *ABC-1234*) ou número de frota.`
        );
        return;
    }

    const veiculo = veiculos.find(v => v.id === veiculoId);
    if (!veiculo) {
        await responder(from, `❌ Veículo não encontrado. Tente novamente com a placa ou número de frota.`);
        return;
    }

    const usaHorimetro = veiculoUsaHorimetro(veiculo.tipo);
    const d = {
        ...session.session_data,
        veiculo_id:    veiculoId,
        veiculo_placa: veiculo.placa,
        veiculo_tipo:  veiculo.tipo,
        usa_horimetro: usaHorimetro,
    };
    await updateSession(session.id, 'obra', d);

    const [obras] = await db.query(
        `SELECT id, nome FROM obras WHERE status IN ('Em Andamento','Planejada','Ativa','ativo') ORDER BY nome LIMIT 25`
    );
    const listaObras = obras.length
        ? obras.map((o, i) => `${i + 1}. *${o.nome}*`).join('\n')
        : '_Nenhuma obra ativa encontrada._';

    await responder(from,
        `✅ Veículo: *${veiculo.placa}*${veiculo.registroInterno ? ` (Frota ${veiculo.registroInterno})` : ''}\n\n` +
        `*Passo 2/6 — Obra/Projeto*\nQual obra está sendo atendida?\n\n${listaObras}`
    );
}

async function handleObra(session, from, body) {
    const [obras] = await db.query(
        `SELECT id, nome FROM obras WHERE status IN ('Em Andamento','Planejada','Ativa','ativo') ORDER BY nome`
    );

    const obraId = await claudeMatchObra(body, obras);
    if (!obraId) {
        await responder(from, `❌ Não encontrei a obra "*${body}*".\n\nTente novamente com o nome da obra.`);
        return;
    }

    const obra = obras.find(o => o.id === obraId);
    if (!obra) {
        await responder(from, `❌ Obra não encontrada. Tente novamente.`);
        return;
    }

    const d = { ...session.session_data, obra_id: obraId, obra_nome: obra.nome };
    await updateSession(session.id, 'combustivel', d);

    await responder(from,
        `✅ Obra: *${obra.nome}*\n\n` +
        `*Passo 3/6 — Combustível*\nQual tipo de combustível?\n\n` +
        `1️⃣ *DIESEL S10*\n2️⃣ *DIESEL S500*\n3️⃣ *GASOLINA COMUM*\n\nDigite o número ou o nome.`
    );
}

async function handleCombustivel(session, from, body) {
    const bl = body.toLowerCase();
    let tipo = null;

    if      (bl.includes('1') || bl.includes('s10'))           tipo = 'DIESEL S10';
    else if (bl.includes('2') || bl.includes('s500'))          tipo = 'DIESEL S500';
    else if (bl.includes('3') || bl.includes('gasolina'))      tipo = 'GASOLINA COMUM';

    if (!tipo) {
        await responder(from,
            `❌ Combustível não reconhecido.\n\nDigite:\n1️⃣ DIESEL S10\n2️⃣ DIESEL S500\n3️⃣ GASOLINA COMUM`
        );
        return;
    }

    const usaHorimetro = session.session_data.usa_horimetro;
    const d = { ...session.session_data, tipo_combustivel: tipo };
    await updateSession(session.id, 'leitura', d);

    const tipoLabel = usaHorimetro ? 'Horímetro (horas)' : 'Odômetro (km)';
    const exemplo   = usaHorimetro ? '1250' : '98450';

    await responder(from,
        `✅ Combustível: *${tipo}*\n\n` +
        `*Passo 4/6 — ${tipoLabel}*\n` +
        `Qual a leitura atual do *${tipoLabel.toLowerCase()}* do veículo?\n\nDigite apenas o número (ex: *${exemplo}*)`
    );
}

async function handleLeitura(session, from, body) {
    const usaHorimetro = session.session_data.usa_horimetro;
    const leitura      = await claudeExtrairLeitura(body, usaHorimetro);

    if (leitura === null) {
        const ex = usaHorimetro ? '1250' : '98450';
        await responder(from,
            `❌ Não entendi o valor "*${body}*".\n\nDigite apenas o número (ex: *${ex}*)`
        );
        return;
    }

    const campo = usaHorimetro ? 'horimetro' : 'odometro';
    const d     = { ...session.session_data, [campo]: leitura };
    await updateSession(session.id, 'litragem', d);

    const leituraFmt = leitura.toLocaleString('pt-BR');
    const unidade    = usaHorimetro ? 'h' : 'km';

    await responder(from,
        `✅ ${usaHorimetro ? 'Horímetro' : 'Odômetro'}: *${leituraFmt} ${unidade}*\n\n` +
        `*Passo 5/6 — Quantidade*\nQuantos litros serão abastecidos?\n\n` +
        `Digite o número de litros (ex: *150*) ou envie *cheio* para tanque cheio.`
    );
}

async function handleLitragem(session, from, body) {
    const resultado = await claudeExtrairLitragem(body);

    if (!resultado) {
        await responder(from,
            `❌ Não entendi a quantidade "*${body}*".\n\nDigite o número de litros (ex: *150*) ou *cheio* para tanque cheio.`
        );
        return;
    }

    const d = {
        ...session.session_data,
        litragem:          resultado.litragem,
        flag_tanque_cheio: resultado.flag_tanque_cheio,
    };
    await updateSession(session.id, 'foto', d);

    const qtdLabel = resultado.flag_tanque_cheio ? '*Tanque Cheio*' : `*${resultado.litragem} litros*`;

    await responder(from,
        `✅ Quantidade: ${qtdLabel}\n\n` +
        `*Passo 6/6 — Foto do Painel*\n\n` +
        `📸 Envie uma *foto do painel* do veículo.`
    );
}

async function handleFoto(session, from, body, hasMedia, mediaBase64, mediaMimetype) {
    if (!hasMedia || !mediaBase64) {
        await responder(from,
            `📸 Aguardando a *foto do painel* do veículo.\n\nTire uma foto e envie aqui.`
        );
        return;
    }

    if (mediaMimetype && !mediaMimetype.startsWith('image/')) {
        await responder(from,
            `❌ Envie uma *imagem* (foto) do painel. Arquivo do tipo ${mediaMimetype} não é aceito.`
        );
        return;
    }

    let fotoPath;
    try {
        fotoPath = salvarFotoBase64(mediaBase64, mediaMimetype || 'image/jpeg');
    } catch (err) {
        console.error('[CHATBOT] Erro ao salvar foto:', err.message);
        await responder(from, `❌ Erro ao processar a foto. Por favor, envie novamente.`);
        return;
    }

    await updateSession(session.id, 'confirmacao', session.session_data, fotoPath);

    const d            = session.session_data;
    const usaHorimetro = d.usa_horimetro;
    const leituraLabel = usaHorimetro
        ? `Horímetro: *${(d.horimetro || 0).toLocaleString('pt-BR')} h*`
        : `Odômetro: *${(d.odometro || 0).toLocaleString('pt-BR')} km*`;
    const qtdLabel = d.flag_tanque_cheio ? '*Tanque Cheio*' : `*${d.litragem} litros*`;

    await responder(from,
        `✅ Foto recebida!\n\n` +
        `*Resumo da Solicitação:*\n\n` +
        `🚗 Veículo: *${d.veiculo_placa}*\n` +
        `🏗️ Obra: *${d.obra_nome}*\n` +
        `⛽ Combustível: *${d.tipo_combustivel}*\n` +
        `📊 ${leituraLabel}\n` +
        `🪣 Quantidade: ${qtdLabel}\n\n` +
        `Deseja confirmar o envio?\n\n✅ Digite *confirmar*\n❌ Digite *cancelar*`
    );
}

async function handleConfirmacao(session, from, body) {
    const bl = body.toLowerCase().trim();

    if (bl.includes('confirm') || bl === 'sim' || bl === 's' || bl === '1') {
        // Recarregar sessão completa para garantir foto_painel_path
        const [rows] = await db.query(
            `SELECT * FROM whatsapp_chatbot_sessions WHERE id = ?`,
            [session.id]
        );
        if (!rows.length) {
            await responder(from, `❌ Sessão expirada. Envie *oi* para iniciar uma nova solicitação.`);
            return;
        }
        const full = rows[0];
        if (typeof full.session_data === 'string') {
            try { full.session_data = JSON.parse(full.session_data); } catch (_) { full.session_data = {}; }
        }

        try {
            const result = await criarSolicitacaoDB(full);
            if (result.error) {
                await responder(from,
                    `⚠️ Não foi possível criar a solicitação:\n${result.error}\n\nEnvie *oi* para tentar novamente.`
                );
                await cancelSession(session.id);
                return;
            }
            await updateSession(session.id, 'concluido', full.session_data);
            await responder(from,
                `🎉 *Solicitação #${result.id} criada com sucesso!*\n\n` +
                `Sua solicitação foi enviada para análise.\n` +
                `Você receberá uma notificação quando for aprovada.\n\n` +
                `_Envie *oi* para fazer uma nova solicitação._`
            );
        } catch (err) {
            console.error('[CHATBOT] Erro ao criar solicitação:', err);
            await responder(from, `❌ Erro ao salvar a solicitação. Tente novamente ou contate o gestor.`);
        }

    } else if (bl.includes('cancel') || bl === 'não' || bl === 'nao' || bl === 'n' || bl === '2') {
        await cancelSession(session.id);
        await responder(from, `❌ Solicitação descartada.\n\nEnvie *oi* para iniciar uma nova solicitação.`);

    } else {
        await responder(from, `Responda *confirmar* para enviar ou *cancelar* para descartar.`);
    }
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

async function processarMensagem({ from, body, hasMedia, mediaBase64, mediaMimetype }) {
    const bodyLower = body.toLowerCase().trim();

    // Cancelamento global (qualquer step)
    if (CANCEL_KEYWORDS.has(bodyLower)) {
        const session = await getSession(from);
        if (session) {
            await cancelSession(session.id);
            await responder(from, `✅ Solicitação cancelada.\n\nEnvie *oi* para iniciar uma nova.`);
        }
        return;
    }

    let session = await getSession(from);

    if (!session) {
        const isStart = START_KEYWORDS.some(kw => bodyLower.includes(kw));
        if (!isStart && !hasMedia) return; // Ignorar mensagens que não iniciam o fluxo

        const funcionario = await identificarFuncionario(from);
        if (!funcionario) {
            await responder(from,
                `⚠️ *Frotas MAK*\n\n` +
                `Não encontrei seu cadastro no sistema.\n` +
                `Seu número não está associado a nenhum funcionário ativo.\n\n` +
                `Entre em contato com o RH ou gestor.`
            );
            return;
        }

        session = await createSession(from, funcionario.id, funcionario.nome);

        const [veiculos] = await db.query(
            `SELECT id, placa, registroInterno, modelo FROM vehicles WHERE status = 'Ativo' ORDER BY placa LIMIT 25`
        );
        const listaVeiculos = veiculos.length
            ? veiculos.map((v, i) =>
                `${i + 1}. *${v.placa}*${v.registroInterno ? ` — Frota ${v.registroInterno}` : (v.modelo ? ` — ${v.modelo}` : '')}`
              ).join('\n')
            : '_Nenhum veículo ativo encontrado._';

        await responder(from,
            `👋 Olá, *${funcionario.nome}*!\n\n` +
            `Bem-vindo ao *Chatbot de Abastecimento Frotas MAK*.\n\n` +
            `*Passo 1/6 — Veículo*\n` +
            `Qual veículo você vai abastecer?\n` +
            `Digite a *placa* ou o *número de frota*:\n\n` +
            `${listaVeiculos}\n\n` +
            `_Envie *cancelar* a qualquer momento para cancelar._`
        );
        return;
    }

    switch (session.step) {
        case 'veiculo':     await handleVeiculo(session, from, body); break;
        case 'obra':        await handleObra(session, from, body); break;
        case 'combustivel': await handleCombustivel(session, from, body); break;
        case 'leitura':     await handleLeitura(session, from, body); break;
        case 'litragem':    await handleLitragem(session, from, body); break;
        case 'foto':        await handleFoto(session, from, body, hasMedia, mediaBase64, mediaMimetype); break;
        case 'confirmacao': await handleConfirmacao(session, from, body); break;
        default:
            await responder(from, `Envie *oi* para iniciar uma nova solicitação.`);
    }
}

module.exports = { processarMensagem };
