// services/emailService.js
// Envio simples de e-mail usando nodemailer + configuração armazenada em
// admin_settings (chave 'email_config'). Mesma config exposta na aba
// Admin → Configurações → E-mail.

const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');
const db = require('../database');

// Registra cada tentativa de envio em email_log (auditoria).
// Nunca lança — falha de log não deve quebrar o envio.
const logEmail = async ({ to, subject, body, tipo, status, erro, messageId, enviadoPor }) => {
    try {
        await db.query(
            `INSERT INTO email_log (id, para, assunto, corpo, tipo, status, erro, message_id, enviado_por)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                randomUUID(),
                String(to).slice(0, 255),
                subject ? String(subject).slice(0, 255) : null,
                body || null,
                tipo || null,
                status,
                erro ? String(erro).slice(0, 1000) : null,
                messageId || null,
                enviadoPor || null,
            ]
        );
    } catch (e) {
        console.warn('⚠️ [emailService] falha ao gravar email_log:', e.message);
    }
};

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

const sendEmail = async ({ to, subject, text, html, attachments, tipo, enviadoPor }) => {
    if (!to) throw new Error('Destinatário (to) obrigatório.');
    const body = text || html || null;
    const config = await getEmailConfig();
    if (!config || !config.host || !config.user) {
        const msg = 'SMTP não configurado em Admin → Configurações.';
        console.warn(`[emailService] ${msg} — destino: ${to}`);
        await logEmail({ to, subject, body, tipo, status: 'skipped', erro: msg, enviadoPor });
        return { skipped: true, reason: msg };
    }

    // Reaproveita transporter se a config não mudou
    const sig = JSON.stringify({ h: config.host, p: config.port, u: config.user });
    if (!cachedTransporter || cachedConfigSignature !== sig) {
        cachedTransporter = buildTransporter(config);
        cachedConfigSignature = sig;
    }

    const from = `"${config.fromName || 'MAK Frotas'}" <${config.fromAddress || config.user}>`;
    try {
        const info = await cachedTransporter.sendMail({ from, to, subject, text, html, attachments });
        await logEmail({ to, subject, body, tipo, status: 'sent', messageId: info.messageId, enviadoPor });
        return { messageId: info.messageId };
    } catch (err) {
        await logEmail({ to, subject, body, tipo, status: 'failed', erro: err.message, enviadoPor });
        throw err;
    }
};

module.exports = { sendEmail };
