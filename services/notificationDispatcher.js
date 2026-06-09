// services/notificationDispatcher.js
// Dispara notificações configuradas em `notification_targets` para um event_type.
// Resolve cada target_type em telefones/e-mails e despacha via WhatsApp ou e-mail.
//
// Uso:
//   const { dispatch } = require('./notificationDispatcher');
//   await dispatch('cnh_vencendo', { funcionario: 'João', data: '2026-07-01', dias: 30 });
//
// O catálogo de templates abaixo define a mensagem por evento. Se o evento não
// estiver no catálogo, usa um template genérico baseado em JSON.stringify.

const db = require('../database');
const whatsappService = require('./whatsappService');
const { sendEmail } = require('./emailService');

const fmtDate = (d) => {
    if (!d) return '—';
    try {
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return String(d);
        return dt.toLocaleDateString('pt-BR');
    } catch { return String(d); }
};

const TEMPLATES = {
    obra_criada: (p) => ({
        subject: `Nova obra cadastrada: ${p.nome || '—'}`,
        body: `Foi cadastrada uma nova obra no sistema:\n\n` +
              `• Nome: ${p.nome || '—'}\n` +
              `• Órgão contratante: ${p.orgao_contratante || '—'}\n` +
              `• Região: ${p.regiao || '—'}`,
    }),
    funcionario_retornou_ferias: (p) => ({
        subject: `Funcionário retornou de férias: ${p.nome || '—'}`,
        body: `O funcionário *${p.nome || '—'}* retornou de férias e está com status Ativo.`,
    }),
    cnh_vencendo: (p) => ({
        subject: `CNH vencendo: ${p.funcionario || '—'}`,
        body: `A CNH de *${p.funcionario || '—'}* vence em ${fmtDate(p.vencimento)} (${p.dias} dia(s) restante(s)).`,
    }),
    cnh_vencida: (p) => ({
        subject: `CNH vencida: ${p.funcionario || '—'}`,
        body: `🚨 A CNH de *${p.funcionario || '—'}* venceu em ${fmtDate(p.vencimento)}. Atenção imediata necessária.`,
    }),
    toxicologico_vencendo: (p) => ({
        subject: `Exame toxicológico vencendo: ${p.funcionario || '—'}`,
        body: `O exame toxicológico de *${p.funcionario || '—'}* vence em ${fmtDate(p.vencimento)} (${p.dias} dia(s) restante(s)).`,
    }),
    combustivel_obra_20pct: (p) => ({
        subject: `Combustível da obra ${p.obra || '—'} a ${p.pct || '—'}% do limite`,
        body: `⚠️ A obra *${p.obra || '—'}* atingiu *${p.pct || '—'}%* do orçamento de combustível.` +
              (p.gastoAtual && p.orcamento ? `\n\nGasto atual: R$ ${Number(p.gastoAtual).toFixed(2)} / R$ ${Number(p.orcamento).toFixed(2)}` : ''),
    }),
    obra_progresso: (p) => ({
        subject: `Obra ${p.obra || '—'} atingiu ${p.pct || '—'}%`,
        body: `📊 A obra *${p.obra || '—'}* atingiu *${p.pct || '—'}%* de progresso.`,
    }),
    revisao_veiculo_leve: (p) => ({
        subject: `Revisão próxima: ${p.placa || '—'}`,
        body: `🔧 Veículo *${p.placa || '—'}* (${p.modelo || '—'}) próximo da revisão.\n` +
              `Km atual: ${p.kmAtual || '—'} / Km revisão: ${p.kmRevisao || '—'}`,
    }),
    revisao_veiculo_pesado: (p) => ({
        subject: `Revisão próxima: ${p.placa || '—'}`,
        body: `🔧 Equipamento *${p.placa || '—'}* (${p.modelo || '—'}) próximo da revisão.\n` +
              `Hr atual: ${p.hrAtual || '—'} / Hr revisão: ${p.hrRevisao || '—'}`,
    }),
    ordem_gerada: (p) => ({
        subject: `Ordem de abastecimento ${p.numero || ''}`.trim(),
        body: `📄 Ordem de abastecimento gerada.\n\n` +
              `• Número: ${p.numero || '—'}\n` +
              `• Veículo: ${p.veiculo || '—'}\n` +
              `• Posto: ${p.posto || '—'}\n` +
              `• Litros: ${p.litros || '—'}\n` +
              `• Combustível: ${p.combustivel || '—'}`,
        anexoUrl: p.pdfUrl || null,
    }),
    multa_lancada: (p) => ({
        subject: `Multa registrada: ${p.funcionario || '—'}`,
        body: `🚨 Multa registrada para *${p.funcionario || '—'}*.\n\n` +
              `• Motivo: ${p.motivo || '—'}\n` +
              `• Valor: R$ ${p.valor ? Number(p.valor).toFixed(2) : '—'}\n` +
              `• Veículo: ${p.placa || '—'}`,
        anexoUrl: p.pdfUrl || null,
    }),
    documento_veiculo_vencido: (p) => ({
        subject: `Documento vencido: ${p.placa || '—'}`,
        body: `🚨 Documento *${p.tipoDocumento || '—'}* do veículo *${p.placa || '—'}* venceu em ${fmtDate(p.vencimento)}.`,
    }),
    operador_placeholder_obra_7dias: (p) => {
        const lista = Array.isArray(p.veiculos) ? p.veiculos : [];
        const linhas = lista.map(v =>
            `• ${v.registroInterno || '—'} (${v.placa || '—'}) — obra "${v.obraNome || '—'}" — operador fictício *${v.operadorPlaceholder || '—'}* há *${v.dias}* dia(s)`
        );
        const titulo = `Veículos sem operador real em obra (>7 dias)`;
        const body = `🚧 *${titulo}*\n\n` +
            `Os veículos abaixo estão alocados em obra com um operador fictício/placeholder ` +
            `(COLABORADOR, TESTE, MAK SERVIÇOS etc.) há mais de 7 dias. ` +
            `Enquanto não for atualizado o operador real, novas ordens de abastecimento ficam *bloqueadas*.\n\n` +
            (linhas.length > 0 ? linhas.join('\n') : '_(nenhum veículo identificado nesta varredura)_') +
            `\n\nAtualize o operador em *Operacional → Alocação em Obra* de cada veículo.`;
        return { subject: titulo, body };
    },
};

const renderTemplate = (eventType, payload) => {
    const tpl = TEMPLATES[eventType];
    if (tpl) return tpl(payload || {});
    return {
        subject: `Notificação: ${eventType}`,
        body: `Evento *${eventType}* disparado.\n\nDetalhes:\n${JSON.stringify(payload || {}, null, 2)}`,
    };
};

// ─── Resolução de destinos ────────────────────────────────────────────────────
// Retorna array de { channel, contact, name } prontos para envio.
const resolveTargets = async (targets) => {
    const resolved = [];
    for (const t of targets) {
        try {
            if (t.target_type === 'phone' && t.channel === 'whatsapp') {
                resolved.push({ channel: 'whatsapp', contact: t.target_value, name: t.label || 'Destino avulso' });
            } else if (t.target_type === 'email_address' && t.channel === 'email') {
                resolved.push({ channel: 'email', contact: t.target_value, name: t.label || 'Destino avulso' });
            } else if (t.target_type === 'employee') {
                const [rows] = await db.query('SELECT nome, contato, email FROM employees WHERE id = ?', [t.target_value]);
                const emp = rows[0];
                if (!emp) continue;
                if (t.channel === 'whatsapp' && emp.contato) resolved.push({ channel: 'whatsapp', contact: emp.contato, name: emp.nome });
                if (t.channel === 'email'    && emp.email)   resolved.push({ channel: 'email',    contact: emp.email,   name: emp.nome });
            } else if (t.target_type === 'user') {
                const [rows] = await db.query('SELECT name, email FROM users WHERE id = ?', [t.target_value]);
                const u = rows[0];
                if (!u) continue;
                if (t.channel === 'email' && u.email) resolved.push({ channel: 'email', contact: u.email, name: u.name });
                // users não possui telefone; whatsapp via user é ignorado
            } else if (t.target_type === 'role') {
                const [rows] = await db.query(
                    "SELECT name, email FROM users WHERE role = ? AND (status = 'ativo' OR status = 'Ativo' OR status IS NULL)",
                    [t.target_value]
                );
                for (const u of rows) {
                    if (t.channel === 'email' && u.email) resolved.push({ channel: 'email', contact: u.email, name: u.name });
                    // whatsapp por role idem: sem coluna de telefone em users
                }
            }
        } catch (err) {
            console.warn(`[notif] falha ao resolver target ${t.id}:`, err.message);
        }
    }
    return resolved;
};

// ─── Despacho principal ───────────────────────────────────────────────────────
const dispatch = async (eventType, payload = {}, opts = {}) => {
    try {
        const [targets] = await db.query(
            'SELECT * FROM notification_targets WHERE event_type = ? AND active = 1',
            [eventType]
        );
        if (!targets || targets.length === 0) {
            return { dispatched: 0, skipped: 0, reason: 'no_targets' };
        }

        const { subject, body, anexoUrl } = renderTemplate(eventType, payload);
        const resolved = await resolveTargets(targets);

        // Deduplica por (channel + contact) para não enviar 2x ao mesmo destino
        const seen = new Set();
        const uniq = resolved.filter(r => {
            const k = `${r.channel}:${String(r.contact).toLowerCase()}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        let dispatched = 0;
        const errors = [];
        await Promise.all(uniq.map(async (r) => {
            try {
                if (r.channel === 'whatsapp') {
                    await whatsappService.enviarMensagem(
                        r.contact,
                        r.name || '—',
                        eventType,
                        body,
                        opts.anexoUrl || anexoUrl || null
                    );
                    dispatched++;
                } else if (r.channel === 'email') {
                    await sendEmail({
                        to: r.contact,
                        subject,
                        text: body,
                        html: body.replace(/\n/g, '<br/>'),
                        attachments: opts.attachments || (anexoUrl ? [{ path: anexoUrl }] : undefined),
                    });
                    dispatched++;
                }
            } catch (err) {
                errors.push({ channel: r.channel, contact: r.contact, error: err.message });
            }
        }));

        if (errors.length) console.warn(`[notif:${eventType}] ${errors.length} erro(s):`, errors);
        return { dispatched, skipped: uniq.length - dispatched, errors };
    } catch (err) {
        console.error(`[notif:${eventType}] falha geral:`, err);
        return { dispatched: 0, skipped: 0, error: err.message };
    }
};

// Fire-and-forget: não trava o controller chamador.
const dispatchAsync = (eventType, payload, opts) => {
    setImmediate(() => {
        dispatch(eventType, payload, opts).catch(err => {
            console.error(`[notif:${eventType}] dispatchAsync error:`, err.message);
        });
    });
};

module.exports = { dispatch, dispatchAsync, TEMPLATES };
