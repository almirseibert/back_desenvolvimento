const db = require('../database');
const { randomUUID } = require('crypto');

// Cria uma sugestão. Qualquer usuário autenticado pode enviar.
// Aceita anexos (prints) via multipart — os arquivos já foram salvos pelo multer.
const createSuggestion = async (req, res) => {
    try {
        const texto = (req.body.texto || '').trim();
        if (!texto) return res.status(400).json({ error: 'Descreva sua sugestão.' });

        const anexos = Array.isArray(req.files)
            ? req.files.map(f => `/uploads/${f.filename}`)
            : [];

        const id = randomUUID();
        await db.query(
            `INSERT INTO suggestions (id, user_id, user_nome, texto, anexos, status)
             VALUES (?, ?, ?, ?, ?, 'nova')`,
            [id, req.user?.id || null, req.user?.name || req.user?.email || null, texto, JSON.stringify(anexos)]
        );

        if (req.io) req.io.emit('server:sync', { resource: 'suggestions' });
        res.status(201).json({ id, message: 'Sugestão enviada. Obrigado!' });
    } catch (error) {
        console.error('❌ Erro ao criar sugestão:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao enviar sugestão.' });
    }
};

// Lista sugestões (admin).
const listSuggestions = async (req, res) => {
    try {
        const { status } = req.query;
        const conds = [];
        const params = [];
        if (status) { conds.push('status = ?'); params.push(status); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const [rows] = await db.query(
            `SELECT * FROM suggestions ${where} ORDER BY created_at DESC LIMIT 500`,
            params
        );
        const parsed = rows.map(r => ({
            ...r,
            anexos: typeof r.anexos === 'string' ? safeParse(r.anexos) : (r.anexos || []),
        }));
        res.json(parsed);
    } catch (error) {
        console.error('Erro ao listar sugestões:', error);
        res.status(500).json({ error: 'Erro ao listar sugestões.' });
    }
};

const updateSuggestionStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const valid = ['nova', 'lida', 'resolvida', 'arquivada'];
        if (!valid.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
        const [r] = await db.query('UPDATE suggestions SET status = ? WHERE id = ?', [status, req.params.id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Sugestão não encontrada.' });
        if (req.io) req.io.emit('server:sync', { resource: 'suggestions' });
        res.json({ message: 'Status atualizado.' });
    } catch (error) {
        console.error('Erro ao atualizar sugestão:', error);
        res.status(500).json({ error: 'Erro ao atualizar sugestão.' });
    }
};

function safeParse(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = { createSuggestion, listSuggestions, updateSuggestionStatus };
