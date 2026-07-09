// controllers/terceirizadoPagamentoController.js
// Pagamentos em dinheiro a locadores (equipamentos terceirizados).
// Abatem do saldo devido calculado no frontend (utils/terceirizados.js).
const db = require('../database');
const { randomUUID } = require('crypto');

const getTerceirizadoPagamentos = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM terceirizado_pagamentos ORDER BY data DESC, created_at DESC'
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro ao listar pagamentos de terceirizados:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao listar pagamentos.' });
    }
};

const createTerceirizadoPagamento = async (req, res) => {
    const { locadorId, vehicleId, data, valor, descricao, createdBy } = req.body;
    if (!locadorId) return res.status(400).json({ error: 'Locador é obrigatório.' });
    const valorNum = parseFloat(valor);
    if (!valorNum || valorNum <= 0) return res.status(400).json({ error: 'Valor de pagamento inválido.' });

    const id = randomUUID();
    const criadoPor = createdBy?.userEmail || req.user?.email || null;

    try {
        await db.execute(
            `INSERT INTO terceirizado_pagamentos
                (id, locadorId, vehicleId, data, valor, descricao, created_by_email)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, locadorId, vehicleId || null, data || null, valorNum, descricao || null, criadoPor]
        );
        const [rows] = await db.query('SELECT * FROM terceirizado_pagamentos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceirizadoPagamentos'] });
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('❌ Erro ao criar pagamento de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao registrar pagamento.' });
    }
};

const updateTerceirizadoPagamento = async (req, res) => {
    const { id } = req.params;
    const { locadorId, vehicleId, data, valor, descricao } = req.body;
    const valorNum = parseFloat(valor);
    if (!valorNum || valorNum <= 0) return res.status(400).json({ error: 'Valor de pagamento inválido.' });

    try {
        const [result] = await db.execute(
            `UPDATE terceirizado_pagamentos
                SET locadorId = ?, vehicleId = ?, data = ?, valor = ?, descricao = ?
              WHERE id = ?`,
            [locadorId, vehicleId || null, data || null, valorNum, descricao || null, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Pagamento não encontrado.' });
        const [rows] = await db.query('SELECT * FROM terceirizado_pagamentos WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['terceirizadoPagamentos'] });
        res.json(rows[0]);
    } catch (error) {
        console.error('❌ Erro ao atualizar pagamento de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao atualizar pagamento.' });
    }
};

const deleteTerceirizadoPagamento = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.execute('DELETE FROM terceirizado_pagamentos WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Pagamento não encontrado.' });
        if (req.io) req.io.emit('server:sync', { targets: ['terceirizadoPagamentos'] });
        res.status(204).end();
    } catch (error) {
        console.error('❌ Erro ao excluir pagamento de terceirizado:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao excluir pagamento.' });
    }
};

module.exports = {
    getTerceirizadoPagamentos,
    createTerceirizadoPagamento,
    updateTerceirizadoPagamento,
    deleteTerceirizadoPagamento,
};
