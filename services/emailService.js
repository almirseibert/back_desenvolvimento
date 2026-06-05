// services/emailService.js
// Envio simples de e-mail usando nodemailer + configuração armazenada em
// admin_settings (chave 'email_config'). Mesma config exposta na aba
// Admin → Configurações → E-mail.

const nodemailer = require('nodemailer');
const db = require('../database');

const getEmailConfig = async () => {
    const [rows] = await db.query("SELECT value FROM admin_settings WHERE setting_key = 'email_config'");
    if (rows.length === 0) return null;
    try {
        const v = rows[0].value;
        return typeof v === 'string' ? JSON.parse(v) : v;
    } catch {
        return null;
    }
};

let cachedTransporter = null;
let cachedConfigSignature = null;

const buildTransporter = (config) => {
    const port = Number(config.port) || 587;
    return nodemailer.createTransport({
        host: config.host,
        port,
        secure: port === 465, // 465 = SSL direto; 587 = STARTTLS
        auth: { user: config.user, pass: config.password },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
    });
};

const sendEmail = async ({ to, subject, text, html, attachments }) => {
    if (!to) throw new Error('Destinatário (to) obrigatório.');
    const config = await getEmailConfig();
    if (!config || !config.host || !config.user) {
        const msg = 'SMTP não configurado em Admin → Configurações.';
        console.warn(`[emailService] ${msg} — destino: ${to}`);
        return { skipped: true, reason: msg };
    }

    // Reaproveita transporter se a config não mudou
    const sig = JSON.stringify({ h: config.host, p: config.port, u: config.user });
    if (!cachedTransporter || cachedConfigSignature !== sig) {
        cachedTransporter = buildTransporter(config);
        cachedConfigSignature = sig;
    }

    const from = `"${config.fromName || 'MAK Frotas'}" <${config.fromAddress || config.user}>`;
    const info = await cachedTransporter.sendMail({ from, to, subject, text, html, attachments });
    return { messageId: info.messageId };
};

module.exports = { sendEmail };
