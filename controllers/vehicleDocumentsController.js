const db = require('../database');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const listDocuments = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar documentos:', error);
        res.status(500).json({ error: 'Erro ao listar documentos' });
    }
};

const uploadDocument = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const { nome, tipo } = req.body;
    const url = `/uploads/${req.file.filename}`;
    const id = randomUUID();

    try {
        await db.execute(
            'INSERT INTO vehicle_documents (id, vehicle_id, nome, tipo, url, tamanho, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, req.params.id, nome || req.file.originalname, tipo || 'Outro', url, req.file.size, req.user?.id || null]
        );
        console.log(`📄 Documento adicionado ao veículo ${req.params.id}: ${nome}`);
        res.status(201).json({ id, url, nome, tipo });
    } catch (error) {
        console.error('Erro ao salvar documento:', error);
        res.status(500).json({ error: 'Erro ao salvar documento' });
    }
};

const deleteDocument = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT url FROM vehicle_documents WHERE id = ? AND vehicle_id = ?',
            [req.params.docId, req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Documento não encontrado.' });
        }

        const filePath = path.resolve(process.cwd(), 'public', rows[0].url.substring(1));
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            console.warn('[deleteDocument] Falha ao deletar arquivo físico:', e.message);
        }

        await db.execute('DELETE FROM vehicle_documents WHERE id = ?', [req.params.docId]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar documento:', error);
        res.status(500).json({ error: 'Erro ao deletar documento' });
    }
};

module.exports = { listDocuments, uploadDocument, deleteDocument };
