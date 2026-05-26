const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const db = require('../database');

// Status + QR Code
router.get('/status', async (req, res) => {
    try {
        const data = await whatsappService.getStatus(); // await estava faltando
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reiniciar cliente
router.post('/reiniciar', async (req, res) => {
    try {
        await whatsappService.reiniciar();
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar mensagem de teste
router.post('/enviar-teste', async (req, res) => {
    const { numero, mensagem } = req.body;
    if (!numero || !mensagem) {
        return res.status(400).json({ error: 'Campos obrigatórios: numero, mensagem' });
    }
    try {
        await whatsappService.enviarMensagem(numero, 'Teste Admin', 'TESTE_ADMIN', mensagem);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Histórico de mensagens
router.get('/logs', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, destinatario_nome, destinatario_numero, motivo_envio,
                    mensagem, status, data_envio
             FROM whatsapp_logs
             ORDER BY data_envio DESC
             LIMIT 50`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Sessões ativas do chatbot
router.get('/chatbot-sessions', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, phone_number, employee_name, step, last_activity, created_at
             FROM whatsapp_chatbot_sessions
             WHERE step NOT IN ('concluido', 'cancelado')
               AND last_activity >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
             ORDER BY last_activity DESC
             LIMIT 50`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;