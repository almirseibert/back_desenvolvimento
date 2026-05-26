const db = require('../database');

const getUserId = (req) => {
    const id = req.user?.uid || req.user?.id || req.user?.userId || req.userId || req.uid;
    if (id) return id;
    if (typeof req.user === 'string' || typeof req.user === 'number') return req.user;
    return null;
};

const safeParam = (param) => param === undefined ? null : param;

exports.getEventos = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Usuário não autenticado.' });

        // Solução Mágica de Fuso: DATE_FORMAT obriga o MySQL a devolver como texto exato
        const query = `
            SELECT id, user_id, title, description, 
            DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime, 
            color_hex, is_completed, reminders
            FROM user_agenda 
            WHERE user_id = ? ORDER BY event_datetime ASC
        `;
        const [eventos] = await db.query(query, [userId]);
        
        // Parse do JSON de reminders para enviar certinho pro front
        const eventosFormatados = eventos.map(ev => ({
            ...ev,
            reminders: ev.reminders ? (typeof ev.reminders === 'string' ? JSON.parse(ev.reminders) : ev.reminders) : []
        }));

        res.status(200).json(eventosFormatados || []);
    } catch (error) {
        console.error('Erro DB (getEventos):', error);
        res.status(500).json({ error: 'Erro interno ao buscar eventos.' });
    }
};

exports.criarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Não autenticado.' });

        const { title, description, event_datetime, color_hex, reminders } = req.body;

        if (!title || !event_datetime) {
            return res.status(400).json({ error: 'Título e data/hora são obrigatórios.' });
        }

        // Formata os lembretes garantindo que iniciem com sent: false
        const formatedReminders = Array.isArray(reminders) ? reminders.map(r => ({
            ...r,
            sent: false
        })) : [];

        const remindersJson = JSON.stringify(formatedReminders);

        const [result] = await db.query(`
            INSERT INTO user_agenda 
            (user_id, title, description, event_datetime, color_hex, notification_status, reminders) 
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `, [userId, title, description || '', event_datetime, color_hex || '#3B82F6', remindersJson]);

        res.status(201).json({ message: 'Evento criado!', id: result.insertId });
    } catch (error) {
        console.error('Erro DB (criarEvento):', error);
        res.status(500).json({ error: 'Erro interno ao criar evento.' });
    }
};

exports.atualizarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;
        const { title, description, event_datetime, color_hex, reminders } = req.body;

        const remindersJson = Array.isArray(reminders) ? JSON.stringify(reminders) : JSON.stringify([]);

        const [result] = await db.query(`
            UPDATE user_agenda 
            SET title = ?, description = ?, event_datetime = ?, color_hex = ?, reminders = ?
            WHERE id = ? AND user_id = ?
        `, [title, description || '', event_datetime, color_hex, remindersJson, eventId, userId]);

        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Evento atualizado!' });
    } catch (error) {
        console.error('Erro DB (atualizarEvento):', error);
        res.status(500).json({ error: 'Erro ao atualizar evento.' });
    }
};

exports.marcarConcluido = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;
        const { is_completed } = req.body;

        const isCompletedValue = (is_completed === true || is_completed === 'true' || is_completed === 1) ? 1 : 0;
        const [result] = await db.query('UPDATE user_agenda SET is_completed = ? WHERE id = ? AND user_id = ?', [isCompletedValue, eventId, userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Status atualizado!' });
    } catch (error) {
        console.error('Erro DB (marcarConcluido):', error);
        res.status(500).json({ error: 'Erro ao alterar status.' });
    }
};

exports.deletarEvento = async (req, res) => {
    try {
        const userId = getUserId(req);
        const eventId = req.params.id;

        const [result] = await db.query('DELETE FROM user_agenda WHERE id = ? AND user_id = ?', [eventId, userId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
        res.status(200).json({ message: 'Evento excluído!' });
    } catch (error) {
        console.error('Erro DB (deletarEvento):', error);
        res.status(500).json({ error: 'Erro ao excluir evento.' });
    }
};

exports.getNotificacoesPendentes = async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Não autenticado.' });

        const [notificacoes] = await db.query(`
            SELECT id, title, DATE_FORMAT(event_datetime, '%Y-%m-%dT%H:%i:%s') as event_datetime, color_hex
            FROM user_agenda 
            WHERE user_id = ? AND is_completed = FALSE AND event_datetime >= CURDATE()
            ORDER BY event_datetime ASC LIMIT 5
        `, [userId]);
        res.status(200).json(notificacoes || []);
    } catch (error) {
        console.error('Erro DB (getNotificacoes):', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
};