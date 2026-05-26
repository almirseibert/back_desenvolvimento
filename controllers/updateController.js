// controllers/updateController.js
const db = require('../database');
const { parseJsonSafe } = require('../utils/parseJsonSafe'); // Supondo que você criou um util

// --- GET: Obter todas as atualizações ---
const getAllUpdates = async (req, res) => {
    try {
        // Ordena para que a mais recente apareça primeiro
        const [rows] = await db.execute('SELECT * FROM updates ORDER BY timestamp DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar atualizações:', error);
        res.status(500).json({ error: 'Erro ao buscar atualizações' });
    }
};

// --- POST: Criar uma nova atualização ---
const createUpdate = async (req, res) => {
    const { message, showPopup } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }

    const newUpdate = {
        message: message,
        showPopup: !!showPopup, // Converte para booleano
        timestamp: new Date()
    };

    const query = 'INSERT INTO updates (message, showPopup, timestamp) VALUES (?, ?, ?)';
    
    try {
        const [result] = await db.execute(query, [newUpdate.message, newUpdate.showPopup, newUpdate.timestamp]);
        
        // EMITIR EVENTO SOCKET.IO
        // Dispara o alerta para todos os clientes conectados imediatamente
        req.io.emit('server:sync', { targets: ['updates'] });

        res.status(201).json({ id: result.insertId, ...newUpdate });
    } catch (error) {
        console.error('Erro ao criar atualização:', error);
        res.status(500).json({ error: 'Erro ao criar atualização' });
    }
};

// --- DELETE: Deletar uma atualização ---
const deleteUpdate = async (req, res) => {
    const { id } = req.params;
    
    try {
        const [result] = await db.execute('DELETE FROM updates WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Atualização não encontrada.' });
        }
        
        // EMITIR EVENTO SOCKET.IO
        req.io.emit('server:sync', { targets: ['updates'] });

        res.status(204).end(); // Sucesso, sem conteúdo
    } catch (error) {
        console.error('Erro ao deletar atualização:', error);
        res.status(500).json({ error: 'Erro ao deletar atualização' });
    }
};

module.exports = {
    getAllUpdates,
    createUpdate,
    deleteUpdate
};