// services/pushService.js
// Envio de notificações push para dispositivos do app mobile via Expo Push API.
// Tokens ficam em `user_push_tokens` (registrados por POST /auth/push-token).
//
// Uso:
//   const { pushToUsers, pushToRoles } = require('./pushService');
//   await pushToRoles(['admin','gerencia'], { title: 'Nova solicitação', body: '...' });

const db = require('../database');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const isExpoToken = (t) => typeof t === 'string' && /^ExponentPushToken\[.+\]$/.test(t.trim());

// Envia uma lista de mensagens à Expo Push API (em lotes de 100).
const sendExpoMessages = async (messages) => {
    const valid = messages.filter((m) => isExpoToken(m.to));
    if (valid.length === 0) return { sent: 0, tickets: [] };

    const tickets = [];
    for (let i = 0; i < valid.length; i += 100) {
        const chunk = valid.slice(i, i + 100);
        try {
            const res = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(chunk),
            });
            const json = await res.json().catch(() => ({}));
            if (Array.isArray(json.data)) tickets.push(...json.data);
            // DeviceNotRegistered → remove o token morto.
            json.data?.forEach((ticket, idx) => {
                if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
                    removeToken(chunk[idx].to).catch(() => {});
                }
            });
        } catch (err) {
            console.warn('[push] falha ao enviar lote:', err.message);
        }
    }
    return { sent: valid.length, tickets };
};

const removeToken = (token) =>
    db.query('DELETE FROM user_push_tokens WHERE token = ?', [token]);

const buildMessages = (tokens, { title, body, data }) =>
    tokens.map((to) => ({
        to,
        title,
        body,
        data: data || {},
        sound: 'default',
        priority: 'high',
        channelId: 'default',
    }));

const tokensForUsers = async (userIds) => {
    if (!userIds || userIds.length === 0) return [];
    const [rows] = await db.query(
        `SELECT token FROM user_push_tokens WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
        userIds
    );
    return rows.map((r) => r.token);
};

const tokensForRoles = async (roles) => {
    if (!roles || roles.length === 0) return [];
    const [rows] = await db.query(
        `SELECT t.token
           FROM user_push_tokens t
           INNER JOIN users u ON u.id = t.user_id
          WHERE LOWER(u.role) IN (${roles.map(() => '?').join(',')})
            AND (u.status = 'ativo' OR u.status = 'Ativo' OR u.status IS NULL)`,
        roles.map((r) => String(r).toLowerCase())
    );
    return rows.map((r) => r.token);
};

const dedupe = (arr) => [...new Set(arr)];

const pushToTokens = async (tokens, payload) => {
    const uniq = dedupe(tokens).filter(isExpoToken);
    if (uniq.length === 0) return { sent: 0 };
    return sendExpoMessages(buildMessages(uniq, payload));
};

const pushToUsers = async (userIds, payload) =>
    pushToTokens(await tokensForUsers(userIds), payload);

const pushToRoles = async (roles, payload) =>
    pushToTokens(await tokensForRoles(roles), payload);

module.exports = {
    pushToTokens,
    pushToUsers,
    pushToRoles,
    tokensForUsers,
    tokensForRoles,
    isExpoToken,
};
