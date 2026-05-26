// controllers/counterController.js
const db = require('../database');

const getCounter = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM counters WHERE name = ?', [req.params.name]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Contador não encontrado' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar contador:', error);
        res.status(500).json({ error: 'Erro ao buscar contador' });
    }
};

const updateCounter = async (req, res) => {
    const { name } = req.params;
    const { lastNumber } = req.body;
    try {
        await db.execute('UPDATE counters SET lastNumber = ? WHERE name = ?', [lastNumber, name]);
        res.json({ message: 'Contador atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar contador:', error);
        res.status(500).json({ error: 'Erro ao atualizar contador' });
    }
};

module.exports = {
    getCounter,
    updateCounter,
};