const axios = require('axios');
const db = require('../database');

const WA_URL = process.env.WHATSAPP_SERVICE_URL;
const WA_KEY = process.env.WHATSAPP_SERVICE_KEY;

const CONTATOS_INTERNOS = {
    ALMIR:     '555199111090',
    LEANDRO:   '555192481722',
    PLINIO:    '555180348479',
    AMANDA:    '555198196762',
    MARLISE:   '555196588016',
    RH:        '555181598177',
    SAULO:     '555197120502',
    ALEXANDRO: '555181708680'
};

function formatarNumero(numero) {
    if (!numero) return null;
    const str = String(numero);
    // Preserva sufixos WhatsApp (@c.us, @lid) para roteamento correto no microsserviço
    const suffixMatch = str.match(/(@\S+)$/);
    const suffix = suffixMatch ? suffixMatch[1] : null;
    let limpo = str.replace(/\D/g, '');
    if (!limpo) return null;
    let formatted;
    if (limpo.length === 8 || limpo.length === 9) formatted = '5551' + limpo;
    else if (limpo.length === 10 || limpo.length === 11) formatted = '55' + limpo;
    else formatted = limpo;
    return suffix ? formatted + suffix : formatted;
}

function waHeaders() {
    return { apikey: WA_KEY };
}

const whatsappService = {
    async getStatus() {
        if (!WA_URL || !WA_KEY) {
            console.error('⚠️ WHATSAPP_SERVICE_URL ou WHATSAPP_SERVICE_KEY não definidos.');
            if (global.io) global.io.emit('admin:notificacao', { tipo: 'whatsapp_nao_configurado' });
            return { status: 'NAO_CONFIGURADO', qr: null };
        }
        try {
            const { data } = await axios.get(`${WA_URL}/status`, { headers: waHeaders(), timeout: 5000 });
            return data;
        } catch (error) {
            console.error('❌ Serviço WhatsApp DESCONECTADO:', error.message);
            // item 7: notifica admin via socket
            if (global.io) global.io.emit('admin:notificacao', { tipo: 'whatsapp_desconectado', erro: error.message });
            return { status: 'DESCONECTADO', qr: null };
        }
    },

    async reiniciar() {
        if (!WA_URL || !WA_KEY) throw new Error('Serviço WhatsApp não configurado.');
        const { data } = await axios.post(`${WA_URL}/restart`, {}, { headers: waHeaders() });
        return data;
    },

    async enviarMensagem(numeroDestino, nomeDestinatario, motivo, mensagem, anexoUrl = null, anexoFilename = null, anexoBase64 = null, anexoMimetype = null) {
        if (!WA_URL || !WA_KEY) {
            console.warn(`⚠️ Ignorando envio para ${nomeDestinatario} (WhatsApp não configurado).`);
            return null;
        }

        const numeroFormatado = formatarNumero(numeroDestino);
        if (!numeroFormatado) throw new Error('Número de destino inválido.');

        try {
            const payload = { number: numeroFormatado, message: mensagem };
            if (anexoUrl) payload.documentUrl = anexoUrl;
            if (anexoFilename) payload.documentFilename = anexoFilename;
            // Prioriza o PDF embutido como base64 — evita que o microsserviço
            // precise baixar a URL pública (que pode falhar em redes isoladas
            // de container, certificados ausentes etc.).
            if (anexoBase64) {
                payload.documentBase64 = anexoBase64;
                payload.documentMimetype = anexoMimetype || 'application/pdf';
            }

            // PDF anexado (base64) chega facilmente a 200–600 KB; com o microsserviço
            // tendo que primeiro mandar o texto e depois subir a mídia via WA Web, 15 s
            // estourava antes do anexo chegar — text saía, PDF não. Subimos para 120 s,
            // e também elevamos os limits do axios para o body grande não ser truncado.
            const { data } = await axios.post(
                `${WA_URL}/send`,
                payload,
                {
                    headers: waHeaders(),
                    timeout: 120000,
                    maxBodyLength: 50 * 1024 * 1024,
                    maxContentLength: 50 * 1024 * 1024,
                }
            );

            const messageId = data.messageId || null;
            // O microsserviço retorna pdfStatus = 'enviado' | 'falha: <msg>' | null.
            // Quando há anexo solicitado mas o WA Web falhou em enviá-lo, registramos
            // como PARCIAL para ficar visível nos logs/admin que o PDF não chegou.
            const pediuAnexo = !!(anexoBase64 || anexoUrl);
            const pdfStatus = data.pdfStatus || null;
            const statusFinal = pediuAnexo
                ? (pdfStatus === 'enviado' ? 'ENVIADO' : (pdfStatus ? 'PARCIAL' : 'ENVIADO'))
                : 'ENVIADO';

            await db.query(
                `INSERT INTO whatsapp_logs
                 (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, message_id_api, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, messageId, statusFinal]
            );

            if (pediuAnexo && pdfStatus && pdfStatus !== 'enviado') {
                console.warn(`⚠️ Mensagem enviada para ${nomeDestinatario} (${numeroFormatado}) — PDF: ${pdfStatus}`);
            } else {
                console.log(`✅ Mensagem enviada para ${nomeDestinatario} (${numeroFormatado})${pediuAnexo ? ' (com PDF)' : ''}`);
            }
            return data;

        } catch (error) {
            // Extrai a mensagem real: resposta HTTP do microsserviço → mensagem do axios
            const erroReal = error.response?.data?.error ?? error.response?.data ?? error.message ?? String(error);

            // Log detalhado para facilitar diagnóstico (especialmente erros minificados do WA Web)
            console.error('❌ Erro no envio WhatsApp:', {
                numero:       numeroFormatado,
                httpStatus:   error.response?.status,
                responseData: error.response?.data,
                axiosMsg:     error.message,
                axiosCode:    error.code,
            });

            try {
                await db.query(
                    `INSERT INTO whatsapp_logs
                     (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, status)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, 'FALHA']
                );
            } catch (_) {}

            // Converte para string sem double-encoding (antes era JSON.stringify, que transformava "t" em '"t"')
            const msgErro = typeof erroReal === 'string' ? erroReal : JSON.stringify(erroReal);
            throw new Error(msgErro);
        }
    },

    CONTATOS_INTERNOS
};

module.exports = whatsappService;
