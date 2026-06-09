// services/orderNotifier.js
// Orquestra o envio automático de ordens de abastecimento (entrada do
// comboio, ordem de abastecimento padrão) pelos canais configurados:
//   - Posto fornecedor: respeita partners.envia_por_whatsapp / envia_por_email
//   - Comboio (origem):  sempre envia se houver contato preenchido na
//                        aba Admin → Veículos → Comboios

const db = require('../database');
const fs = require('fs');
const path = require('path');
const whatsappService = require('./whatsappService');
const { sendEmail } = require('./emailService');
const { generateOrderPdf } = require('./pdfGenerator');
const { buildComboioPartnerId } = require('../utils/ensureComboioPartner');

// Diretório onde os PDFs ficam hospedados — servido via /uploads/ordens
const ORDERS_PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'ordens');
try { if (!fs.existsSync(ORDERS_PDF_DIR)) fs.mkdirSync(ORDERS_PDF_DIR, { recursive: true }); } catch (_) {}

// Base URL pública usada para o WhatsApp anexar o PDF.
// Em produção: definir PUBLIC_API_URL=https://seu-backend.com no .env.
const publicBase = () => {
    const fromEnv = process.env.PUBLIC_API_URL || process.env.REACT_APP_API_URL;
    if (fromEnv) return fromEnv.replace(/\/api\/?$/, '').replace(/\/$/, '');
    return `http://localhost:${process.env.PORT || 3001}`;
};

// Formata a data em YYYY-MM-DD no fuso BRT (GMT-3).
const fmtDateISO = (d) => {
    try {
        const date = d ? new Date(d) : new Date();
        const brt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const y = brt.getFullYear();
        const m = String(brt.getMonth() + 1).padStart(2, '0');
        const day = String(brt.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    } catch { return 'data'; }
};

// Gera o PDF da ordem, salva em disco e devolve { buffer, url, filename, filepath }.
// Nome: Autorizacao_<authNumber>_<registroInterno>_<YYYY-MM-DD>.pdf
const buildOrderPdfArtifact = async (order) => {
    const buffer = await generateOrderPdf(order);
    const authNum = String(order.authNumber || 'TEMP').replace(/\W+/g, '');
    const ri = String(order.registroInterno || '').replace(/[^\w-]/g, '') || 'V';
    const dateStr = fmtDateISO(order.date);
    const filename = `Autorizacao_${authNum}_${ri}_${dateStr}.pdf`;
    const filepath = path.join(ORDERS_PDF_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    const url = `${publicBase()}/uploads/ordens/${filename}`;
    return { buffer, url, filename, filepath };
};

// ─── Formatação ─────────────────────────────────────────────────────────────
const fmtMoney = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return 'R$ 0,00';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const fmtFuel = (f) => {
    if (!f) return '—';
    const map = { dieselS10: 'Diesel S10', dieselS500: 'Diesel S500', dieselComum: 'Diesel Comum',
                  gasolinaComum: 'Gasolina Comum', gasolinaAditivada: 'Gasolina Aditivada',
                  etanol: 'Etanol', arla32: 'Arla 32' };
    return map[f] || f;
};

const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch { return String(d); }
};

// ─── Templates ──────────────────────────────────────────────────────────────
const buildOrderText = (order) => {
    const veiculoLinha = [order.vehicleLabel, order.vehicleModelo].filter(Boolean).join(' | ');
    const litrosLinha = order.isFillUp ? 'Tanque Cheio' : `${parseFloat(order.liters || 0).toFixed(2)} L`;
    const lines = [
        `*Ordem de Abastecimento Nº ${String(order.authNumber || '').padStart(6, '0')}*`,
        ``,
        `📅 Data: ${fmtDate(order.date)}`,
        `🚛 Veículo: ${veiculoLinha || '—'}`,
        `⛽ Combustível: ${fmtFuel(order.fuelType)}`,
        `🛢️ Quantidade: ${litrosLinha}`,
    ];
    if (order.readingLabel && order.readingValue && order.readingValue !== 'N/A') lines.push(`📏 ${order.readingLabel}: ${order.readingValue}`);
    if (order.pricePerLiter) lines.push(`💰 Valor/L: ${fmtMoney(order.pricePerLiter)}`);
    if (order.valorTotal)    lines.push(`💵 Total: ${fmtMoney(order.valorTotal)}`);
    if (order.invoiceNumber) lines.push(`🧾 NF: ${order.invoiceNumber}`);
    if (order.obraName)      lines.push(`🏗️ Obra: ${order.obraName}`);
    if (order.employeeName)  lines.push(`👤 Funcionário: ${order.employeeName}`);
    if (order.partnerName)   lines.push(`🏪 Posto: ${order.partnerName}`);
    if (order.needsArla) {
        const arlaQt = order.isFillUpArla ? 'Completar Tanque' : `${parseFloat(order.litrosLiberadosArla || 0).toFixed(2)} L`;
        lines.push(`🧪 Arla 32 Autorizado: ${arlaQt}`);
    }
    if (order.outros) {
        const valor = order.outrosValor ? ` (${fmtMoney(order.outrosValor)})` : '';
        lines.push(`➕ Outros: ${order.outros}${valor}`);
    }
    if (order.observacao)    lines.push(``, `📝 ${order.observacao}`);
    lines.push(``, `_Mensagem automática — Sistema MAK Frotas_`);
    return lines.join('\n');
};

const buildOrderHtml = (order) => {
    const row = (k, v) => v ? `<tr><td style="padding:4px 8px;border:1px solid #e5e7eb;font-weight:600;background:#f9fafb">${k}</td><td style="padding:4px 8px;border:1px solid #e5e7eb">${v}</td></tr>` : '';
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px">
        <h2 style="background:#fbbf24;color:#1f2937;padding:12px;margin:0;border-radius:6px 6px 0 0">
            Ordem de Abastecimento Nº ${String(order.authNumber || '').padStart(6, '0')}
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:0;border:1px solid #e5e7eb">
            ${row('Data',         fmtDate(order.date))}
            ${row('Veículo',      [order.vehicleLabel, order.vehicleModelo].filter(Boolean).join(' | '))}
            ${row('Combustível',  fmtFuel(order.fuelType))}
            ${row('Quantidade',   order.isFillUp ? 'Tanque Cheio' : `${parseFloat(order.liters || 0).toFixed(2)} L`)}
            ${order.readingLabel && order.readingValue && order.readingValue !== 'N/A' ? row(order.readingLabel, order.readingValue) : ''}
            ${row('Valor/L',      order.pricePerLiter ? fmtMoney(order.pricePerLiter) : '')}
            ${row('Total',        order.valorTotal    ? fmtMoney(order.valorTotal)    : '')}
            ${row('Nota Fiscal',  order.invoiceNumber)}
            ${row('Obra',         order.obraName)}
            ${row('Funcionário',  order.employeeName)}
            ${row('Posto',        order.partnerName)}
            ${order.needsArla ? row('Arla 32 Autorizado', order.isFillUpArla ? 'Completar Tanque' : `${parseFloat(order.litrosLiberadosArla || 0).toFixed(2)} L`) : ''}
            ${order.outros ? row('Outros Itens/Observação', `${order.outros}${order.outrosValor ? ` (${fmtMoney(order.outrosValor)})` : ''}`) : ''}
            ${row('Observação',   order.observacao)}
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:12px">Mensagem automática — Sistema MAK Frotas</p>
    </div>`;
};

// ─── Envio para um partner específico, conforme suas flags ──────────────────
// opts.forceWhatsapp / opts.forceEmail ignoram as flags do partner (usado para o comboio)
// opts.pdf = { buffer, url, filename } — pré-gerado uma vez e reusado entre canais
const sendToPartner = async (partner, order, opts = {}) => {
    const out = { whatsapp: null, email: null };
    if (!partner) return out;

    const wantWa = opts.forceWhatsapp || partner.envia_por_whatsapp == 1;
    const wantEm = opts.forceEmail    || partner.envia_por_email    == 1;
    const pdf = opts.pdf || null;

    if (wantWa && partner.whatsapp) {
        try {
            await whatsappService.enviarMensagem(
                partner.whatsapp,
                partner.razaoSocial || 'Posto',
                `ordem_${order.tipo || 'abastecimento'}_${order.authNumber || ''}`,
                buildOrderText(order),
                pdf?.url || null,
                pdf?.filename || null
            );
            out.whatsapp = pdf?.url ? 'enviado (com PDF)' : 'enviado';
        } catch (e) {
            console.warn(`[orderNotifier] WhatsApp falhou para ${partner.razaoSocial}:`, e.message);
            out.whatsapp = `falha: ${e.message}`;
        }
    }

    if (wantEm && partner.email) {
        try {
            const attachments = pdf?.buffer ? [{
                filename: pdf.filename || `Autorizacao_${order.authNumber || 'TEMP'}.pdf`,
                content: pdf.buffer,
                contentType: 'application/pdf',
            }] : undefined;
            const authNum = String(order.authNumber || '').padStart(6, '0');
            const ri = order.registroInterno || '';
            const dateStr = fmtDateISO(order.date);
            const emailSubject = ri
                ? `Autorizacao_${authNum}_${ri}_${dateStr}`
                : `Ordem de Abastecimento Nº ${authNum}`;
            const r = await sendEmail({
                to: partner.email,
                subject: emailSubject,
                text: buildOrderText(order),
                html: buildOrderHtml(order),
                attachments,
            });
            out.email = r.skipped ? `pulado: ${r.reason}` : (pdf?.buffer ? 'enviado (com PDF)' : 'enviado');
        } catch (e) {
            console.warn(`[orderNotifier] E-mail falhou para ${partner.razaoSocial}:`, e.message);
            out.email = `falha: ${e.message}`;
        }
    }

    return out;
};

// ─── Notificação principal de entrada do comboio ────────────────────────────
// Envia para:
//   1) Posto fornecedor (respeita flags envia_por_whatsapp / envia_por_email)
//   2) Comboio (sempre — quando há contato configurado)
const notifyComboioEntrada = async ({ partnerId, comboioVehicleId, order }) => {
    const result = { posto: null, comboio: null, pdf: null };

    // Gera o PDF UMA vez e reusa em todos os canais/destinatários
    let pdf = null;
    try {
        pdf = await buildOrderPdfArtifact(order);
        result.pdf = { url: pdf.url, filename: pdf.filename };
    } catch (e) {
        console.warn('[orderNotifier] geração de PDF falhou:', e.message);
    }

    // 1) Posto fornecedor
    if (partnerId) {
        try {
            const [rows] = await db.query(
                `SELECT id, razaoSocial, whatsapp, email, envia_por_whatsapp, envia_por_email
                 FROM partners WHERE id = ?`, [partnerId]
            );
            if (rows.length > 0) {
                result.posto = await sendToPartner(
                    rows[0],
                    { ...order, partnerName: rows[0].razaoSocial },
                    { pdf }
                );
            }
        } catch (e) {
            console.warn('[orderNotifier] erro ao buscar posto:', e.message);
        }
    }

    // 2) Comboio (espelho em partners) — sempre tenta enviar se contato existir
    if (comboioVehicleId) {
        try {
            const comboioPartnerId = buildComboioPartnerId(comboioVehicleId);
            const [rows] = await db.query(
                `SELECT id, razaoSocial, whatsapp, email FROM partners WHERE id = ?`,
                [comboioPartnerId]
            );
            if (rows.length > 0) {
                const c = rows[0];
                // Para o comboio, força os canais que tiverem contato cadastrado
                result.comboio = await sendToPartner(
                    { ...c, envia_por_whatsapp: c.whatsapp ? 1 : 0, envia_por_email: c.email ? 1 : 0 },
                    order,
                    { forceWhatsapp: !!c.whatsapp, forceEmail: !!c.email, pdf }
                );
            }
        } catch (e) {
            console.warn('[orderNotifier] erro ao buscar comboio:', e.message);
        }
    }

    return result;
};

module.exports = {
    notifyComboioEntrada,
    sendToPartner,
    buildOrderText,
    buildOrderHtml,
    buildOrderPdfArtifact,
};
