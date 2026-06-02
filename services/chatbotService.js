'use strict';

const path       = require('path');
const fs         = require('fs');
const Anthropic  = require('@anthropic-ai/sdk');
const db         = require('../database');
const whatsappService = require('./whatsappService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SESSION_TIMEOUT_MIN = 30;
const FOTO_UPLOAD_DIR     = path.join(__dirname, '../public/uploads/solicitacoes');
const MAX_FOTO_BYTES      = 5 * 1024 * 1024; // item 22: 5 MB

const CANCEL_KEYWORDS = new Set(['cancelar', 'cancel', 'sair', 'reiniciar', 'restart', 'início', 'inicio']);
const BACK_KEYWORDS   = new Set(['voltar', 'volta', 'back', 'anterior']);
// item 5: word-boundary match at start of message only
const START_PATTERN = /^(oi|olá|ola|abastecimento|abastecer|solicitar|inicio|início)\b/i;

// item 19: rate limiting (10 mensagens/min por número)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX    = 10;
const RATE_LIMIT_WINDOW = 60_000;

// item 6: concurrency guard
const processingPhones = new Set();

const STEP_ANTERIOR = {
    obra:        'veiculo',
    posto:       'obra',
    combustivel: 'posto',
    leitura:     'combustivel',
    litragem:    'leitura',
    foto:        'litragem',
    confirmacao: 'foto',
};

const CAMPOS_A_LIMPAR = {
    veiculo:     ['veiculo_id', 'veiculo_placa', 'veiculo_tipo', 'usa_horimetro'],
    obra:        ['obra_id', 'obra_nome'],
    posto:       ['posto_id', 'posto_nome'],
    combustivel: ['tipo_combustivel'],
    leitura:     ['horimetro', 'odometro', 'leitura_pendente', 'leitura_pendente_menor'],
    litragem:    ['litragem', 'flag_tanque_cheio'],
    foto:        [],
    confirmacao: [],
};

const TIPOS_HORIMETRO = new Set([
    'Motoniveladora', 'Pá Carregadeira', 'Retroescavadeira', 'Rolo', 'Trator',
    'Escavadeira', 'Escavadeira + Rompedor', 'Fresadora', 'Trator Esteira',
    'Bitruck', 'Caminhão Pipa', 'Caminhão Tanque', 'Caminhão Carroceria', 'Cavalo',
    'Caçamba Bitruck', 'Caçamba Toco', 'Caçamba Traçado', 'Caçamba Truckado',
    'Caminhão', 'Caçamba',
]);

function veiculoUsaHorimetro(tipo) { return TIPOS_HORIMETRO.has(tipo); }
function formatRI(ri) { return ri ? ri.replace(/^RE\s*/i, '') : ''; }

// item 24: mascarar telefone em logs
function maskPhone(phone) {
    const s = String(phone || '').replace(/\D/g, '');
    return s.length > 4 ? s.slice(0, 2) + '****' + s.slice(-2) : '****';
}

// item 19: rate limit check
function isRateLimited(phone) {
    const now = Date.now();
    const entry = rateLimitMap.get(phone) || { count: 0, firstAt: now };
    if (now - entry.firstAt > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(phone, { count: 1, firstAt: now });
        return false;
    }
    entry.count++;
    rateLimitMap.set(phone, entry);
    return entry.count > RATE_LIMIT_MAX;
}

// item 21: normalização para fuzzy match sem chamar IA
function normalize(str) {
    return (str || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s]/g, '').trim();
}
function fuzzyMatchNome(input, items, field) {
    const n = normalize(input);
    if (n.length < 2) return null;
    for (const item of items) {
        const stored = normalize(item[field] || '');
        if (stored.includes(n) || n.includes(stored.split(' ')[0])) return item;
    }
    return null;
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
    const sessionData = JSON.stringify({ employee_uuid: employeeId });
    // item 8: persiste employee_id em vez de NULL
    const [result] = await db.query(
        `INSERT INTO whatsapp_chatbot_sessions (phone_number, employee_name, step, session_data)
         VALUES (?, ?, 'veiculo', ?)`,
        [phone, employeeName, sessionData]
    );
    return {
        id:             result.insertId,
        phone_number:   phone,
        employee_id:    employeeId,
        employee_name:  employeeName,
        step:           'veiculo',
        session_data:   { employee_uuid: employeeId },
        foto_painel_path: null,
    };
}

// item 1: sempre atualiza last_activity
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

// ─── LAST SOLICITATION (item 9) ───────────────────────────────────────────────

async function buscarUltimaSolicitacao(phone) {
    const [rows] = await db.query(
        `SELECT session_data FROM whatsapp_chatbot_sessions
         WHERE phone_number = ? AND step = 'concluido'
         ORDER BY created_at DESC LIMIT 1`,
        [phone]
    );
    if (!rows.length) return null;
    let data = rows[0].session_data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { return null; } }
    if (!data?.veiculo_id || !data?.obra_id || !data?.tipo_combustivel) return null;
    return data;
}

// ─── VEHICLE-EMPLOYEE LOOKUP ─────────────────────────────────────────────────

async function buscarVeiculoFuncionario(employeeId) {
    const [opRows] = await db.query(
        `SELECT v.id, v.placa, v.registroInterno, v.modelo, v.tipo
         FROM vehicle_operational_assignment a
         INNER JOIN vehicles v ON a.vehicleId = v.id
         WHERE a.employeeId = ? AND a.endDate IS NULL
           AND v.status IN ('Ativo', 'Disponível', 'Em Obra')
         LIMIT 1`,
        [String(employeeId)]
    );
    if (opRows.length) return opRows[0];
    const [obraRows] = await db.query(
        `SELECT v.id, v.placa, v.registroInterno, v.modelo, v.tipo
         FROM obras_historico_veiculos h
         INNER JOIN vehicles v ON h.veiculoId = v.id
         WHERE h.employeeId = ? AND h.dataSaida IS NULL
           AND v.status IN ('Ativo', 'Disponível', 'Em Obra')
         LIMIT 1`,
        [String(employeeId)]
    );
    return obraRows.length ? obraRows[0] : null;
}

// item 3: normaliza o RE armazenado da mesma forma que o input
function matchVeiculoDireto(input, veiculos) {
    const limpo = input.trim().toUpperCase().replace(/[\s\-.]/g, '');
    const semRE = input.trim().replace(/^RE\s*/i, '').trim().toUpperCase().replace(/[\s\-.]/g, '');
    for (const v of veiculos) {
        const placa = (v.placa || '').toUpperCase().replace(/[\s\-.]/g, '');
        if (placa && placa === limpo) return v.id;
    }
    for (const v of veiculos) {
        // item 3: strip prefix do RI armazenado antes de comparar
        const ri = (v.registroInterno || '').replace(/^RE\s*/i, '').toUpperCase().replace(/[\s\-.]/g, '');
        if (ri && (ri === limpo || ri === semRE)) return v.id;
    }
    return null;
}

// ─── EMPLOYEE IDENTIFICATION ──────────────────────────────────────────────────

async function identificarFuncionario(phone) {
    const limpo   = phone.replace(/\D/g, '');
    const semPais = limpo.length > 11 ? limpo.slice(2) : limpo;
    const comPais = limpo.length <= 11 ? '55' + limpo : limpo;
    function varianteBR(num) {
        if (num.length === 10) return num.slice(0, 2) + '9' + num.slice(2);
        if (num.length === 11) return num.slice(0, 2) + num.slice(3);
        return null;
    }
    const semPaisVariante = varianteBR(semPais);
    const variantes = [limpo, semPais, comPais];
    if (semPaisVariante) variantes.push(semPaisVariante, '55' + semPaisVariante);
    const placeholders = variantes.map(() => '?').join(', ');
    const [rows] = await db.query(
        `SELECT id, nome FROM employees WHERE status = 'ativo'
         AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(contato,' ',''),'-',''),'(',''),')',''),'+','')
             IN (${placeholders})
         LIMIT 1`,
        variantes
    );
    return rows.length ? rows[0] : null;
}

// ─── CLAUDE API HELPERS (item 20: try/catch + item 21: fuzzy antes da IA) ────

async function claudeMatchVeiculo(input, veiculos) {
    if (!veiculos.length) return null;
    try {
        const lista = veiculos.map((v, i) =>
            `#${i + 1} | Placa:${v.placa} | RE/Frota:${v.registroInterno || '-'} | Modelo:${v.modelo || '-'} | Grupo:${v.tipo || '-'}`
        ).join('\n');
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 10,
            system:     'Você identifica veículos de frota brasileira. O campo RE/Frota é o número de registro interno. Responda SOMENTE com o número (#) do veículo mais provável (ex: 3). Se não houver correspondência clara, responda NENHUM. Nenhum outro texto.',
            messages:   [{ role: 'user', content: `Veículos:\n${lista}\n\nOperador digitou: "${input}"\n\nNúmero (#):` }],
        });
        const raw = response.content[0].text.trim().replace(/\D/g, '');
        const idx = parseInt(raw, 10);
        if (isNaN(idx) || idx < 1 || idx > veiculos.length) return null;
        return veiculos[idx - 1].id;
    } catch (err) {
        console.error('[CHATBOT] Claude API falhou (veículo):', err.message);
        return null;
    }
}

async function claudeMatchObra(input, obras) {
    if (!obras.length) return null;
    try {
        const lista = obras.map((o, i) => `#${i + 1} | Nome:${o.nome}`).join('\n');
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 10,
            system:     'Você identifica obras/projetos. Responda SOMENTE com o número (#) da obra mais provável (ex: 2). Se não houver correspondência, responda NENHUM. Nenhum outro texto.',
            messages:   [{ role: 'user', content: `Obras:\n${lista}\n\nOperador digitou: "${input}"\n\nNúmero (#):` }],
        });
        const raw = response.content[0].text.trim().replace(/\D/g, '');
        const idx = parseInt(raw, 10);
        if (isNaN(idx) || idx < 1 || idx > obras.length) return null;
        return obras[idx - 1].id;
    } catch (err) {
        console.error('[CHATBOT] Claude API falhou (obra):', err.message);
        return null;
    }
}

async function claudeMatchPosto(input, postos) {
    if (!postos.length) return null;
    try {
        const lista = postos.map((p, i) => `#${i + 1} | Nome:${p.razaoSocial || p.nome}`).join('\n');
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 10,
            system:     'Você identifica postos de combustível. Responda SOMENTE com o número (#) do posto mais provável (ex: 2). Se não houver correspondência, responda NENHUM. Nenhum outro texto.',
            messages:   [{ role: 'user', content: `Postos:\n${lista}\n\nOperador digitou: "${input}"\n\nNúmero (#):` }],
        });
        const raw = response.content[0].text.trim().replace(/\D/g, '');
        const idx = parseInt(raw, 10);
        if (isNaN(idx) || idx < 1 || idx > postos.length) return null;
        return postos[idx - 1].id;
    } catch (err) {
        console.error('[CHATBOT] Claude API falhou (posto):', err.message);
        return null;
    }
}

async function claudeExtrairLeitura(input, usaHorimetro) {
    const tipo = usaHorimetro ? 'horímetro em horas' : 'odômetro em quilômetros';
    try {
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
    } catch (err) {
        console.error('[CHATBOT] Claude API falhou (leitura):', err.message);
        // fallback: tenta parsear diretamente
        const num = parseFloat(input.replace(',', '.').replace(/[^\d.]/g, ''));
        return (isNaN(num) || num <= 0) ? null : num;
    }
}

async function claudeExtrairLitragem(input) {
    try {
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 20,
            system:     'Extraia quantidade de litros de combustível. Se o operador disser "cheio", "tanque cheio" ou variações, responda CHEIO. Caso contrário, responda apenas o número. Se não entender, responda INVALIDO.',
            messages:   [{ role: 'user', content: `"${input}"` }],
        });
        const raw = response.content[0].text.trim().toUpperCase();
        if (raw.includes('CHEIO'))    return { litragem: null, flag_tanque_cheio: 1 };
        if (raw.includes('INVALIDO')) return null;
        const num = parseFloat(raw.replace(',', '.'));
        if (isNaN(num) || num <= 0) return null;
        return { litragem: num, flag_tanque_cheio: 0 };
    } catch (err) {
        console.error('[CHATBOT] Claude API falhou (litragem):', err.message);
        // fallback local
        const bl = input.toLowerCase();
        if (/cheio|tanque\s*cheio/.test(bl)) return { litragem: null, flag_tanque_cheio: 1 };
        const num = parseFloat(input.replace(',', '.').replace(/[^\d.]/g, ''));
        if (isNaN(num) || num <= 0) return null;
        return { litragem: num, flag_tanque_cheio: 0 };
    }
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
        // item 7: log + alerta no admin
        console.error('[CHATBOT] Falha ao enviar mensagem para', maskPhone(phone), ':', err.message);
        if (global.io) {
            global.io.emit('admin:notificacao', { tipo: 'chatbot_erro_envio', phone: maskPhone(phone) });
        }
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

    const employeeUuid = d?.employee_uuid || null;
    const [userRows] = await db.query(
        `SELECT id FROM users WHERE employeeId = ? LIMIT 1`,
        [employeeUuid]
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
             VALUES (?,?,?,?,?,?,?,?,0,?,?,?,0,0,'PENDENTE',0,?,?)`,
            [
                usuarioId, d.veiculo_id, d.obra_id, d.posto_id || null, usuarioId,
                d.tipo_combustivel, d.litragem || 0, d.flag_tanque_cheio || 0,
                d.horimetro || null, d.odometro || null, session.foto_painel_path,
                today, 'Solicitado via WhatsApp',
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

// ─── VEHICLE LIST (item 4: query única com LIMIT 25 usada em exibição e match) ─

async function buscarVeiculosAtivos() {
    const [veiculos] = await db.query(
        `SELECT id, placa, registroInterno, modelo, tipo
         FROM vehicles WHERE status IN ('Ativo', 'Disponível', 'Em Obra')
         ORDER BY placa LIMIT 25`
    );
    return veiculos;
}

// Busca direta por placa ou RE/frota sem depender do LIMIT 25
async function buscarVeiculoPorPlacaOuRE(input) {
    const limpo = input.trim().toUpperCase().replace(/[\s\-.]/g, '');
    const semRE = input.trim().replace(/^RE\s*/i, '').replace(/[\s\-.]/g, '').toUpperCase();
    if (!limpo) return null;
    const [rows] = await db.query(
        `SELECT id, placa, registroInterno, modelo, tipo
         FROM vehicles
         WHERE status IN ('Ativo', 'Disponível', 'Em Obra')
           AND (
             REPLACE(REPLACE(UPPER(placa), ' ', ''), '-', '') = ?
             OR REPLACE(REPLACE(REPLACE(UPPER(registroInterno), 'RE', ''), ' ', ''), '-', '') = ?
           )
         LIMIT 1`,
        [limpo, semRE || limpo]
    );
    return rows[0] || null;
}

// ─── MENU DISPLAY FUNCTIONS ───────────────────────────────────────────────────

async function exibirMenuVeiculo(session, from) {
    const vSugerido = session.session_data?.veiculo_sugerido;
    const ultima    = session.session_data?._ultima;
    let msgVeiculo  = '';

    // item 9: atalho para repetir
    if (ultima?.veiculo_placa) {
        msgVeiculo += `↩️ Digite *R* para repetir: *${ultima.veiculo_placa}* / *${ultima.obra_nome}* / ${ultima.tipo_combustivel}\n\n`;
    }

    if (vSugerido) {
        const reLabel = vSugerido.registroInterno ? ` (RE ${formatRI(vSugerido.registroInterno)})` : '';
        msgVeiculo +=
            `*Veículo associado ao seu cadastro:*\n` +
            `🚗 *${vSugerido.placa}*${reLabel}${vSugerido.modelo ? ` — ${vSugerido.modelo}` : ''}\n\n` +
            `Digite *1* para confirmar, ou informe a *placa* ou *RE* de outro veículo.\n\n`;
    } else {
        const veiculos = await buscarVeiculosAtivos();
        const listaVeiculos = veiculos.length
            ? veiculos.map((v, i) =>
                `${i + 1}. *${v.placa}*${v.registroInterno ? ` — RE ${formatRI(v.registroInterno)}` : (v.modelo ? ` — ${v.modelo}` : '')}`
              ).join('\n')
            : '_Nenhum veículo ativo encontrado._';
        msgVeiculo +=
            `Qual veículo você vai abastecer?\n` +
            `Digite o *número*, a *placa* ou o *número de RE/frota*:\n\n` +
            `${listaVeiculos}\n\n`;
    }

    await responder(from,
        `*Passo 1/7 — Veículo*\n${msgVeiculo}` +
        `_Envie *cancelar* a qualquer momento para cancelar._`
    );
}

async function exibirMenuObra(session, from) {
    const veiculoId = session.session_data?.veiculo_id;
    let obras = [];
    if (veiculoId) {
        const [rows] = await db.query(
            `SELECT DISTINCT o.id, o.nome FROM obras o
             INNER JOIN obras_historico_veiculos h ON h.obraId = o.id
             WHERE h.veiculoId = ? AND h.dataSaida IS NULL
               AND o.status IN ('Em Andamento','Planejada','Ativa','ativo')
             ORDER BY o.nome`,
            [veiculoId]
        );
        obras = rows;
    }
    if (!obras.length) {
        const [rows] = await db.query(
            `SELECT id, nome FROM obras WHERE status IN ('Em Andamento','Planejada','Ativa','ativo') ORDER BY nome LIMIT 25`
        );
        obras = rows;
    }
    const listaObras = obras.length
        ? obras.map((o, i) => `${i + 1}. *${o.nome}*`).join('\n')
        : '_Nenhuma obra ativa encontrada._';
    await responder(from,
        `✅ Veículo: *${session.session_data?.veiculo_placa || ''}*\n\n` +
        `*Passo 2/7 — Obra/Projeto*\n` +
        `Qual obra está sendo atendida?\n\n` +
        `${listaObras}\n\n` +
        `0️⃣ *Voltar*`
    );
}

async function exibirMenuPosto(session, from) {
    const [postos] = await db.query(
        `SELECT id, razaoSocial FROM partners WHERE tipo_parceiro = 'posto' AND status_operacional = 'ativo' ORDER BY razaoSocial`
    );
    const listaPostos = postos.length
        ? postos.map((p, i) => `${i + 1}. *${p.razaoSocial}*`).join('\n')
        : '_Nenhum posto cadastrado._';
    await responder(from,
        `✅ Obra: *${session.session_data?.obra_nome || ''}*\n\n` +
        `*Passo 3/7 — Posto de Combustível*\n` +
        `Qual posto será utilizado?\n\n` +
        `${listaPostos}\n\n` +
        `0️⃣ *Voltar*`
    );
}

async function exibirMenuCombustivel(session, from) {
    await responder(from,
        `✅ Posto: *${session.session_data?.posto_nome || ''}*\n\n` +
        `*Passo 4/7 — Combustível*\n` +
        `Qual tipo de combustível?\n\n` +
        `1️⃣ *DIESEL S10*\n2️⃣ *DIESEL S500*\n3️⃣ *GASOLINA COMUM*\n\n` +
        `0️⃣ *Voltar*`
    );
}

async function exibirMenuLeitura(session, from) {
    const usaHorimetro = session.session_data?.usa_horimetro;
    const tipoLabel    = usaHorimetro ? 'Horímetro (horas)' : 'Odômetro (km)';
    const unidade      = usaHorimetro ? 'h' : 'km';
    const campo        = usaHorimetro ? 'horimetro_informado' : 'odometro_informado';

    let ultimaLeituraMsg = '';
    try {
        const [rows] = await db.query(
            `SELECT ${campo} AS ultima FROM solicitacoes_abastecimento
             WHERE veiculo_id = ? AND ${campo} IS NOT NULL AND status NOT IN ('CANCELADO')
             ORDER BY data_solicitacao DESC, id DESC LIMIT 1`,
            [session.session_data?.veiculo_id]
        );
        if (rows.length && rows[0].ultima !== null) {
            const ultima = parseFloat(rows[0].ultima).toLocaleString('pt-BR');
            ultimaLeituraMsg = `\nÚltima leitura registrada: *${ultima} ${unidade}*\n`;
        }
    } catch (e) {
        console.error('[CHATBOT] Erro ao buscar última leitura:', e.message);
    }

    await responder(from,
        `✅ Combustível: *${session.session_data?.tipo_combustivel || ''}*\n\n` +
        `*Passo 5/7 — ${tipoLabel}*\n` +
        `Qual a leitura atual do *${tipoLabel.toLowerCase()}* do veículo?\n` +
        `${ultimaLeituraMsg}\n` +
        `Digite apenas o número:\n\n` +
        `0️⃣ *Voltar*`
    );
}

async function exibirMenuLitragem(session, from) {
    const usaHorimetro = session.session_data?.usa_horimetro;
    const leitura      = usaHorimetro ? session.session_data?.horimetro : session.session_data?.odometro;
    const unidade      = usaHorimetro ? 'h' : 'km';
    const leituraFmt   = leitura ? leitura.toLocaleString('pt-BR') : '—';
    await responder(from,
        `✅ ${usaHorimetro ? 'Horímetro' : 'Odômetro'}: *${leituraFmt} ${unidade}*\n\n` +
        `*Passo 6/7 — Quantidade*\n` +
        `Quantos litros serão abastecidos?\n\n` +
        `Digite o número de litros (ex: *150*) ou envie *cheio* para tanque cheio.\n\n` +
        `0️⃣ *Voltar*`
    );
}

async function exibirMenuFoto(from) {
    await responder(from,
        `*Passo 7/7 — Foto do Painel*\n\n` +
        `📸 Envie uma *foto do painel* do veículo.\n\n` +
        `0️⃣ *Voltar*`
    );
}

// ─── VOLTAR ───────────────────────────────────────────────────────────────────

async function handleVoltar(session, from) {
    const stepAnterior = STEP_ANTERIOR[session.step];
    if (!stepAnterior) {
        await responder(from, `Você já está no início. Envie *cancelar* para cancelar a solicitação.`);
        return;
    }
    const d = { ...session.session_data };
    for (const campo of (CAMPOS_A_LIMPAR[stepAnterior] || [])) delete d[campo];
    const fotoPainelPath = (session.step === 'confirmacao') ? null : undefined;
    await updateSession(session.id, stepAnterior, d, fotoPainelPath);
    const sessaoAtualizada = { ...session, step: stepAnterior, session_data: d };
    switch (stepAnterior) {
        case 'veiculo':     await exibirMenuVeiculo(sessaoAtualizada, from); break;
        case 'obra':        await exibirMenuObra(sessaoAtualizada, from); break;
        case 'posto':       await exibirMenuPosto(sessaoAtualizada, from); break;
        case 'combustivel': await exibirMenuCombustivel(sessaoAtualizada, from); break;
        case 'leitura':     await exibirMenuLeitura(sessaoAtualizada, from); break;
        case 'litragem':    await exibirMenuLitragem(sessaoAtualizada, from); break;
        case 'foto':        await exibirMenuFoto(from); break;
    }
}

// ─── STEP HANDLERS ────────────────────────────────────────────────────────────

// item 10: avança para obra, pulando automaticamente se houver apenas 1
async function avancarParaObra(session, from) {
    const veiculoId = session.session_data?.veiculo_id;
    let obras = [];
    if (veiculoId) {
        const [rows] = await db.query(
            `SELECT DISTINCT o.id, o.nome FROM obras o
             INNER JOIN obras_historico_veiculos h ON h.obraId = o.id
             WHERE h.veiculoId = ? AND h.dataSaida IS NULL
               AND o.status IN ('Em Andamento','Planejada','Ativa','ativo')
             ORDER BY o.nome`,
            [veiculoId]
        );
        obras = rows;
    }
    if (!obras.length) {
        const [rows] = await db.query(
            `SELECT id, nome FROM obras WHERE status IN ('Em Andamento','Planejada','Ativa','ativo') ORDER BY nome LIMIT 25`
        );
        obras = rows;
    }

    if (obras.length === 1) {
        // item 10: obra única — seleciona e pula para posto
        const obra = obras[0];
        const d = { ...session.session_data, obra_id: obra.id, obra_nome: obra.nome };
        await updateSession(session.id, 'posto', d);
        await responder(from, `✅ Obra *${obra.nome}* selecionada automaticamente.`);
        await exibirMenuPosto({ ...session, step: 'posto', session_data: d }, from);
        return;
    }

    await exibirMenuObra(session, from);
}

async function handleVeiculo(session, from, body) {
    // item 4: query consistente com LIMIT 25
    const veiculos = await buscarVeiculosAtivos();

    // item 9: 'R' para repetir última solicitação
    if (body.trim().toUpperCase() === 'R') {
        const ultima = session.session_data?._ultima;
        if (ultima?.veiculo_id) {
            const usaHorimetro = veiculoUsaHorimetro(ultima.veiculo_tipo || '');
            const d = {
                ...session.session_data,
                veiculo_id:      ultima.veiculo_id,
                veiculo_placa:   ultima.veiculo_placa,
                veiculo_tipo:    ultima.veiculo_tipo,
                usa_horimetro:   usaHorimetro,
                obra_id:         ultima.obra_id,
                obra_nome:       ultima.obra_nome,
                posto_id:        ultima.posto_id,
                posto_nome:      ultima.posto_nome,
                tipo_combustivel: ultima.tipo_combustivel,
            };
            await updateSession(session.id, 'leitura', d);
            await responder(from,
                `↩️ *Repetindo última solicitação:*\n` +
                `🚗 ${ultima.veiculo_placa} | 🏗️ ${ultima.obra_nome} | ⛽ ${ultima.tipo_combustivel}\n\n` +
                `Informe a leitura atual e a quantidade de litros.`
            );
            await exibirMenuLeitura({ ...session, step: 'leitura', session_data: d }, from);
            return;
        }
    }

    // Veículo sugerido confirmado com "1"
    const vSugerido = session.session_data?.veiculo_sugerido;
    if (vSugerido && body.trim() === '1') {
        const veiculoCompleto = veiculos.find(v => v.id === vSugerido.id) || vSugerido;
        const usaHorimetro = veiculoUsaHorimetro(veiculoCompleto.tipo);
        const d = {
            ...session.session_data,
            veiculo_id:    veiculoCompleto.id,
            veiculo_placa: veiculoCompleto.placa,
            veiculo_tipo:  veiculoCompleto.tipo,
            usa_horimetro: usaHorimetro,
        };
        await updateSession(session.id, 'obra', d);
        await avancarParaObra({ ...session, step: 'obra', session_data: d }, from);
        return;
    }

    // Correspondência direta por placa ou RE (item 3 já aplicado em matchVeiculoDireto)
    let veiculoId = matchVeiculoDireto(body, veiculos);

    // Busca direta no banco para placa ou RE que não esteja nos 25 da lista
    if (!veiculoId) {
        const vDireto = await buscarVeiculoPorPlacaOuRE(body);
        if (vDireto) {
            veiculoId = vDireto.id;
            if (!veiculos.find(v => v.id === vDireto.id)) veiculos.push(vDireto);
        }
    }

    // Match por número da lista
    if (!veiculoId) {
        const numSo = /^\d+$/.test(body.trim()) ? parseInt(body.trim(), 10) : NaN;
        if (!isNaN(numSo) && numSo >= 1 && numSo <= veiculos.length) {
            veiculoId = veiculos[numSo - 1].id;
        }
    }

    // Referência genérica ("meu veículo")
    if (!veiculoId) {
        const referenciaGenerica = /\b(meu|minha|esse|este|o meu|meu veiculo|meu veículo)\b/.test(body.toLowerCase());
        if (referenciaGenerica) {
            const employeeId = session.session_data?.employee_uuid;
            if (employeeId) {
                const vAssoc = await buscarVeiculoFuncionario(employeeId);
                if (vAssoc) veiculoId = vAssoc.id;
            }
        }
    }

    // item 21: fuzzy match antes de chamar IA
    if (!veiculoId) {
        const found = fuzzyMatchNome(body, veiculos, 'placa') || fuzzyMatchNome(body, veiculos, 'modelo');
        if (found) veiculoId = found.id;
    }

    // item 20: IA com fallback tratado
    if (!veiculoId) veiculoId = await claudeMatchVeiculo(body, veiculos);

    if (!veiculoId) {
        await responder(from,
            `❌ Não consegui identificar o veículo com "*${body}*".\n\n` +
            `Tente com o *número da lista*, a *placa completa* (ex: *ABC-1234*) ou o *número de RE/frota*.\n\n` +
            `0️⃣ *Voltar*`
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
    await avancarParaObra({ ...session, step: 'obra', session_data: d }, from);
}

async function handleObra(session, from, body) {
    const veiculoId = session.session_data?.veiculo_id;
    let obras = [];
    if (veiculoId) {
        const [rows] = await db.query(
            `SELECT DISTINCT o.id, o.nome FROM obras o
             INNER JOIN obras_historico_veiculos h ON h.obraId = o.id
             WHERE h.veiculoId = ? AND h.dataSaida IS NULL
               AND o.status IN ('Em Andamento','Planejada','Ativa','ativo')
             ORDER BY o.nome`,
            [veiculoId]
        );
        obras = rows;
    }
    if (!obras.length) {
        const [rows] = await db.query(
            `SELECT id, nome FROM obras WHERE status IN ('Em Andamento','Planejada','Ativa','ativo') ORDER BY nome`
        );
        obras = rows;
    }

    let obraId = null;
    const numSo = /^\d+$/.test(body.trim()) ? parseInt(body.trim(), 10) : NaN;
    if (!isNaN(numSo) && numSo >= 1 && numSo <= obras.length) {
        obraId = obras[numSo - 1].id;
    }

    // item 21: fuzzy antes de IA
    if (!obraId) {
        const found = fuzzyMatchNome(body, obras, 'nome');
        if (found) obraId = found.id;
    }

    if (!obraId) obraId = await claudeMatchObra(body, obras);

    if (!obraId) {
        const listaObras = obras.length
            ? obras.map((o, i) => `${i + 1}. *${o.nome}*`).join('\n')
            : '_Nenhuma obra ativa encontrada._';
        await responder(from,
            `❌ Não encontrei a obra "*${body}*".\n\n` +
            `Escolha pelo número ou nome:\n${listaObras}\n\n` +
            `0️⃣ *Voltar*`
        );
        return;
    }

    const obra = obras.find(o => o.id === obraId);
    if (!obra) { await responder(from, `❌ Obra não encontrada. Tente novamente.`); return; }

    const d = { ...session.session_data, obra_id: obraId, obra_nome: obra.nome };
    await updateSession(session.id, 'posto', d);
    await exibirMenuPosto({ ...session, step: 'posto', session_data: d }, from);
}

async function handlePosto(session, from, body) {
    const [postos] = await db.query(
        `SELECT id, razaoSocial FROM partners WHERE tipo_parceiro = 'posto' AND status_operacional = 'ativo' ORDER BY razaoSocial`
    );

    const numSo = /^\d+$/.test(body.trim()) ? parseInt(body.trim(), 10) : NaN;
    let postoId = (!isNaN(numSo) && numSo >= 1 && numSo <= postos.length)
        ? postos[numSo - 1].id : null;

    // item 21: fuzzy antes de IA
    if (!postoId) {
        const found = fuzzyMatchNome(body, postos, 'razaoSocial');
        if (found) postoId = found.id;
    }

    if (!postoId) postoId = await claudeMatchPosto(body, postos);

    if (!postoId) {
        const lista = postos.length
            ? postos.map((p, i) => `${i + 1}. *${p.razaoSocial}*`).join('\n')
            : '_Nenhum posto cadastrado._';
        await responder(from,
            `❌ Não encontrei o posto "*${body}*".\n\nEscolha da lista:\n${lista}\n\n0️⃣ *Voltar*`
        );
        return;
    }

    const posto = postos.find(p => p.id === postoId);
    if (!posto) { await responder(from, `❌ Posto não encontrado. Tente novamente.`); return; }

    const d = { ...session.session_data, posto_id: postoId, posto_nome: posto.razaoSocial };
    await updateSession(session.id, 'combustivel', d);
    await exibirMenuCombustivel({ ...session, step: 'combustivel', session_data: d }, from);
}

// item 2: parser de combustível corrigido — só match exato de número
async function handleCombustivel(session, from, body) {
    const bl    = body.toLowerCase().trim();
    const numSo = /^\d+$/.test(body.trim()) ? parseInt(body.trim(), 10) : NaN;
    let tipo = null;

    if      (numSo === 1 || bl === 's10'    || /diesel\s*s10/.test(bl))  tipo = 'DIESEL S10';
    else if (numSo === 2 || bl === 's500'   || /diesel\s*s500/.test(bl)) tipo = 'DIESEL S500';
    else if (numSo === 3 || /gasolina/.test(bl))                          tipo = 'GASOLINA COMUM';

    if (!tipo) {
        await responder(from,
            `❌ Combustível não reconhecido.\n\n` +
            `1️⃣ DIESEL S10\n2️⃣ DIESEL S500\n3️⃣ GASOLINA COMUM\n\n0️⃣ *Voltar*`
        );
        return;
    }

    const d = { ...session.session_data, tipo_combustivel: tipo };
    await updateSession(session.id, 'leitura', d);
    await exibirMenuLeitura({ ...session, step: 'leitura', session_data: d }, from);
}

async function handleLeitura(session, from, body) {
    const usaHorimetro = session.session_data.usa_horimetro;
    const leitura      = await claudeExtrairLeitura(body, usaHorimetro);

    if (leitura === null) {
        await responder(from,
            `❌ Não entendi o valor "*${body}*".\n\nDigite apenas o número (ex: *12345*)\n\n0️⃣ *Voltar*`
        );
        return;
    }

    // Valida contra última leitura registrada (bloqueia inferior e salto excessivo)
    const campoHistorico = usaHorimetro ? 'horimetro_informado' : 'odometro_informado';
    try {
        const [lastRows] = await db.query(
            `SELECT ${campoHistorico} AS ultima FROM solicitacoes_abastecimento
             WHERE veiculo_id = ? AND ${campoHistorico} IS NOT NULL AND status NOT IN ('CANCELADO')
             ORDER BY data_solicitacao DESC, id DESC LIMIT 1`,
            [session.session_data.veiculo_id]
        );
        if (lastRows.length && lastRows[0].ultima !== null) {
            const ultima   = parseFloat(lastRows[0].ultima);
            const unidade  = usaHorimetro ? 'h' : 'km';
            const deltaMax = usaHorimetro ? 50 : 1000;

            if (leitura < ultima) {
                await responder(from,
                    `❌ O valor *${leitura} ${unidade}* é *menor* que a última leitura registrada (*${ultima.toLocaleString('pt-BR')} ${unidade}*).\n\n` +
                    `Verifique e informe um valor correto.\n\n0️⃣ *Voltar*`
                );
                return;
            }
            if ((leitura - ultima) > deltaMax) {
                await responder(from,
                    `❌ O valor *${leitura} ${unidade}* representa um salto excessivo em relação à última leitura (*${ultima.toLocaleString('pt-BR')} ${unidade}*).\n\n` +
                    `Verifique e informe um valor correto.\n\n0️⃣ *Voltar*`
                );
                return;
            }
        }
    } catch (e) {
        console.error('[CHATBOT] Erro ao validar leitura contra histórico:', e.message);
    }

    const campoSalvo = usaHorimetro ? 'horimetro' : 'odometro';
    const d = { ...session.session_data, [campoSalvo]: leitura };
    await updateSession(session.id, 'litragem', d);
    await exibirMenuLitragem({ ...session, step: 'litragem', session_data: d }, from);
}

async function handleLitragem(session, from, body) {
    const resultado = await claudeExtrairLitragem(body);
    if (!resultado) {
        await responder(from,
            `❌ Não entendi a quantidade "*${body}*".\n\n` +
            `Digite o número de litros (ex: *150*) ou *cheio* para tanque cheio.\n\n0️⃣ *Voltar*`
        );
        return;
    }
    const d = { ...session.session_data, litragem: resultado.litragem, flag_tanque_cheio: resultado.flag_tanque_cheio };
    await updateSession(session.id, 'foto', d);
    await exibirMenuFoto(from);
}

async function handleFoto(session, from, body, hasMedia, mediaBase64, mediaMimetype) {
    if (!hasMedia || !mediaBase64) {
        await responder(from, `📸 Aguardando a *foto do painel* do veículo.\n\nTire uma foto e envie aqui.\n\n0️⃣ *Voltar*`);
        return;
    }
    if (mediaMimetype && !mediaMimetype.startsWith('image/')) {
        await responder(from, `❌ Envie uma *imagem* do painel. Tipo ${mediaMimetype} não é aceito.\n\n0️⃣ *Voltar*`);
        return;
    }
    // item 22: limite de tamanho
    const photoBuffer = Buffer.from(mediaBase64, 'base64');
    if (photoBuffer.length > MAX_FOTO_BYTES) {
        await responder(from, `❌ Foto muito grande (máx. 5 MB). Tire uma foto com menor resolução.\n\n0️⃣ *Voltar*`);
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
        `⛽ Posto: *${d.posto_nome || '-'}*\n` +
        `🔥 Combustível: *${d.tipo_combustivel}*\n` +
        `📊 ${leituraLabel}\n` +
        `🪣 Quantidade: ${qtdLabel}\n\n` +
        `✅ *1* — Confirmar e enviar\n` +
        `❌ *2* — Cancelar\n` +
        `↩️ *0* — Voltar\n\n` +
        `── Corrigir ──\n` +
        `*3* — Alterar quantidade\n` +
        `*4* — Alterar leitura\n` +
        `*5* — Trocar foto`
    );
}

async function handleConfirmacao(session, from, body) {
    const bl = body.toLowerCase().trim();

    // item 11: atalhos de edição direto da confirmação
    if (bl === '3') {
        const d = { ...session.session_data };
        delete d.litragem; delete d.flag_tanque_cheio;
        await updateSession(session.id, 'litragem', d, null);
        await exibirMenuLitragem({ ...session, step: 'litragem', session_data: d }, from);
        return;
    }
    if (bl === '4') {
        const d = { ...session.session_data };
        delete d.horimetro; delete d.odometro;
        await updateSession(session.id, 'leitura', d, null);
        await exibirMenuLeitura({ ...session, step: 'leitura', session_data: d }, from);
        return;
    }
    if (bl === '5') {
        await updateSession(session.id, 'foto', session.session_data, null);
        await exibirMenuFoto(from);
        return;
    }

    if (bl.includes('confirm') || bl === 'sim' || bl === 's' || bl === '1') {
        try {
            const result = await criarSolicitacaoDB(session);
            if (result.error) {
                await responder(from, `⚠️ Não foi possível criar a solicitação:\n${result.error}\n\nEnvie *oi* para tentar novamente.`);
                await cancelSession(session.id);
                return;
            }
            await updateSession(session.id, 'concluido', session.session_data);
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
        await responder(from,
            `Responda:\n` +
            `✅ *1* — Confirmar\n❌ *2* — Cancelar\n↩️ *0* — Voltar\n` +
            `*3* — Alterar quantidade\n*4* — Alterar leitura\n*5* — Trocar foto`
        );
    }
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

async function processarMensagem({ from, phoneNumber, body, hasMedia, mediaBase64, mediaMimetype }) {
    // item 19: rate limiting
    if (isRateLimited(from)) {
        console.warn('[CHATBOT] Rate limit atingido para', maskPhone(from));
        return;
    }
    // item 6: concurrency guard
    if (processingPhones.has(from)) {
        console.warn(`[CHATBOT] Mensagem de ${maskPhone(from)} ignorada — processamento em andamento`);
        return;
    }
    processingPhones.add(from);
    try {
        await _processarMensagem({ from, phoneNumber, body, hasMedia, mediaBase64, mediaMimetype });
    } finally {
        processingPhones.delete(from);
    }
}

async function _processarMensagem({ from, phoneNumber, body, hasMedia, mediaBase64, mediaMimetype }) {
    const bodyLower = body.toLowerCase().trim();
    // item 24: mascara telefone em logs
    console.log(`[CHATBOT] Msg de ${maskPhone(from)}: "${body.substring(0, 60)}" | hasMedia:${hasMedia}`);

    if (CANCEL_KEYWORDS.has(bodyLower)) {
        const session = await getSession(from);
        if (session) {
            await cancelSession(session.id);
            await responder(from, `✅ Solicitação cancelada.\n\nEnvie *oi* para iniciar uma nova.`);
        }
        return;
    }

    let session = await getSession(from);

    if (session && (BACK_KEYWORDS.has(bodyLower) || bodyLower === '0')) {
        await handleVoltar(session, from);
        return;
    }

    if (!session) {
        // item 5: regex com word boundary — não ativa com "ola pessoal" etc.
        const isStart = START_PATTERN.test(bodyLower);
        console.log(`[CHATBOT] isStart=${isStart} para ${maskPhone(from)}`);
        if (!isStart && !hasMedia) return;

        const funcionario = await identificarFuncionario(phoneNumber || from);
        console.log(`[CHATBOT] Funcionário:`, funcionario ? funcionario.nome : 'não encontrado');
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

        const [veiculoAssociado, ultimaData] = await Promise.all([
            buscarVeiculoFuncionario(funcionario.id),
            buscarUltimaSolicitacao(from),
        ]);

        let sessionDataUpdate = { ...session.session_data };
        if (veiculoAssociado) {
            sessionDataUpdate.veiculo_sugerido = {
                id: veiculoAssociado.id, placa: veiculoAssociado.placa,
                registroInterno: veiculoAssociado.registroInterno,
                modelo: veiculoAssociado.modelo, tipo: veiculoAssociado.tipo,
            };
        }
        if (ultimaData) sessionDataUpdate._ultima = ultimaData;
        await updateSession(session.id, 'veiculo', sessionDataUpdate);
        session.session_data = sessionDataUpdate;

        // Monta mensagem de boas-vindas
        let msgVeiculo = '';
        if (ultimaData?.veiculo_placa) {
            msgVeiculo += `↩️ Digite *R* para repetir: *${ultimaData.veiculo_placa}* / *${ultimaData.obra_nome}* / ${ultimaData.tipo_combustivel}\n\n`;
        }
        if (veiculoAssociado) {
            const reLabel = veiculoAssociado.registroInterno ? ` (RE ${formatRI(veiculoAssociado.registroInterno)})` : '';
            msgVeiculo +=
                `*Veículo associado ao seu cadastro:*\n` +
                `🚗 *${veiculoAssociado.placa}*${reLabel}${veiculoAssociado.modelo ? ` — ${veiculoAssociado.modelo}` : ''}\n\n` +
                `Digite *1* para confirmar, ou informe a *placa* ou *RE* de outro veículo.\n\n`;
        } else {
            const veiculos = await buscarVeiculosAtivos();
            const listaVeiculos = veiculos.length
                ? veiculos.map((v, i) =>
                    `${i + 1}. *${v.placa}*${v.registroInterno ? ` — RE ${formatRI(v.registroInterno)}` : (v.modelo ? ` — ${v.modelo}` : '')}`
                  ).join('\n')
                : '_Nenhum veículo ativo encontrado._';
            msgVeiculo +=
                `Qual veículo você vai abastecer?\n` +
                `Digite o *número*, a *placa* ou o *número de RE/frota*:\n\n` +
                `${listaVeiculos}\n\n`;
        }

        await responder(from,
            `👋 Olá, *${funcionario.nome}*!\n\n` +
            `Bem-vindo ao *Chatbot de Abastecimento Frotas MAK*.\n\n` +
            `*Passo 1/7 — Veículo*\n` +
            `${msgVeiculo}` +
            `_Envie *cancelar* a qualquer momento para cancelar._`
        );
        return;
    }

    switch (session.step) {
        case 'veiculo':     await handleVeiculo(session, from, body); break;
        case 'obra':        await handleObra(session, from, body); break;
        case 'posto':       await handlePosto(session, from, body); break;
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
