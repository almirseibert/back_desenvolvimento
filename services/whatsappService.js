const axios = require('axios');
const db = require('../database'); // Mantendo seu import original de DB

const WA_URL = process.env.WHATSAPP_SERVICE_URL; // ex: http://frotasmak-whatsapp:3002 ou https://evo.frotamak.com
const WA_KEY = process.env.WHATSAPP_SERVICE_KEY;

// Mantendo todos os seus contatos internos intactos
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

// Mantendo sua lógica original de formatação de DDD/DDI
function formatarNumero(numero) {
    if (!numero) return null;
    let limpo = String(numero).replace(/\D/g, '');
    if (limpo.length === 8 || limpo.length === 9) return '5551' + limpo;
    if (limpo.length === 10 || limpo.length === 11) return '55' + limpo;
    return limpo;
}

function waHeaders() {
    return { apikey: WA_KEY };
}

const whatsappService = {
    // Busca o status atualizado do microsserviço, que agora retorna {status, qr}
    async getStatus() {
        if (!WA_URL || !WA_KEY) {
            console.error('⚠️ WHATSAPP_SERVICE_URL ou WHATSAPP_SERVICE_KEY não definidos.');
            return { status: 'NAO_CONFIGURADO', qr: null };
        }
        try {
            const { data } = await axios.get(`${WA_URL}/status`, { headers: waHeaders(), timeout: 5000 });
            return data;
        } catch (error) {
            console.error('❌ Erro ao buscar status do WhatsApp:', error.message);
            return { status: 'DESCONECTADO', qr: null };
        }
    },

    async reiniciar() {
        if (!WA_URL || !WA_KEY) throw new Error('Serviço WhatsApp não configurado.');
        const { data } = await axios.post(`${WA_URL}/restart`, {}, { headers: waHeaders() });
        return data;
    },

    // Mantendo a sua função original de envio com Inserção no Banco (whatsapp_logs)
    async enviarMensagem(numeroDestino, nomeDestinatario, motivo, mensagem, anexoUrl = null) {
        if (!WA_URL || !WA_KEY) {
            console.warn(`⚠️ Ignorando envio para ${nomeDestinatario} (WhatsApp não configurado).`);
            return null;
        }

        const numeroFormatado = formatarNumero(numeroDestino);
        if (!numeroFormatado) throw new Error('Número de destino inválido.');

        try {
            const payload = { number: numeroFormatado, message: mensagem };
            if (anexoUrl) payload.documentUrl = anexoUrl.replace('http://', 'https://');

            const { data } = await axios.post(
                `${WA_URL}/send`,
                payload,
                { headers: waHeaders(), timeout: 15000 }
            );

            const messageId = data.messageId || null;

            // Log de SUCESSO no banco de dados mantido intacto
            await db.query(
                `INSERT INTO whatsapp_logs
                 (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, message_id_api, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, messageId, 'ENVIADO']
            );

            console.log(`✅ Mensagem enviada para ${nomeDestinatario} (${numeroFormatado})`);
            return data;

        } catch (error) {
            const erroReal = error.response?.data?.error || error.message;
            console.error('❌ Erro no envio WhatsApp:', erroReal);

            // Log de FALHA no banco de dados mantido intacto
            try {
                await db.query(
                    `INSERT INTO whatsapp_logs
                     (destinatario_nome, destinatario_numero, motivo_envio, mensagem, anexo_url, status)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [nomeDestinatario, numeroFormatado, motivo, mensagem, anexoUrl, 'FALHA']
                );
            } catch (_) {}

            throw new Error(JSON.stringify(erroReal));
        }
    },

    CONTATOS_INTERNOS
};

module.exports = whatsappService;