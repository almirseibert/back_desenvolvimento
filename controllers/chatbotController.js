'use strict';

const chatbotService = require('../services/chatbotService');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const receberMensagem = async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
        console.warn('[WEBHOOK] Segredo inválido de:', req.ip);
        return res.status(401).json({ error: 'Não autorizado.' });
    }

    // Responder imediatamente — o microsserviço não precisa aguardar
    res.status(200).json({ ok: true });

    const { from, phoneNumber, body, hasMedia, mediaBase64, mediaMimetype } = req.body || {};
    if (!from) return;

    chatbotService.processarMensagem({
        from,
        phoneNumber:   phoneNumber   || null,
        body:          (body || '').trim(),
        hasMedia:      !!hasMedia,
        mediaBase64:   mediaBase64  || null,
        mediaMimetype: mediaMimetype || null,
    }).catch(err => {
        console.error('[CHATBOT] Erro ao processar mensagem de', from, ':', err.message);
    });
};

module.exports = { receberMensagem };
