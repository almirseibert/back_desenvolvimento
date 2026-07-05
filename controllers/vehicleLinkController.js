const db = require('../database');
const { randomUUID } = require('crypto');

// Lista vínculos ativos de um veículo (como pai OU como filho), já com dados do
// outro veículo para exibição.
const listLinks = async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const [rows] = await db.query(
            `SELECT vl.*,
                    pv.registroInterno AS parent_registro, pv.placa AS parent_placa, pv.modelo AS parent_modelo,
                    cv.registroInterno AS child_registro,  cv.placa AS child_placa,  cv.modelo AS child_modelo
             FROM vehicle_links vl
             JOIN vehicles pv ON vl.parent_vehicle_id = pv.id
             JOIN vehicles cv ON vl.child_vehicle_id  = cv.id
             WHERE vl.ativo = 1 AND (vl.parent_vehicle_id = ? OR vl.child_vehicle_id = ?)
             ORDER BY vl.created_at DESC`,
            [vehicleId, vehicleId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar vínculos:', error);
        res.status(500).json({ error: 'Erro ao listar vínculos.' });
    }
};

const createLink = async (req, res) => {
    try {
        const { parent_vehicle_id, child_vehicle_id, tipo_vinculo, observacao } = req.body;
        if (!parent_vehicle_id || !child_vehicle_id) {
            return res.status(400).json({ error: 'Veículo principal e atrelado são obrigatórios.' });
        }
        if (parent_vehicle_id === child_vehicle_id) {
            return res.status(400).json({ error: 'Um veículo não pode ser atrelado a si mesmo.' });
        }

        // Ambos os veículos existem?
        const [vs] = await db.query('SELECT id FROM vehicles WHERE id IN (?, ?)', [parent_vehicle_id, child_vehicle_id]);
        if (vs.length < 2) return res.status(404).json({ error: 'Veículo não encontrado.' });

        // O filho já tem um pai ativo? (um reboque/acessório só fica em um conjunto por vez)
        const [existingChild] = await db.query(
            'SELECT id FROM vehicle_links WHERE child_vehicle_id = ? AND ativo = 1',
            [child_vehicle_id]
        );
        if (existingChild.length > 0) {
            return res.status(409).json({ error: 'O veículo atrelado já está vinculado a outro. Desvincule antes.' });
        }

        // Evita ciclo direto (A→B e B→A ativos)
        const [reverse] = await db.query(
            'SELECT id FROM vehicle_links WHERE parent_vehicle_id = ? AND child_vehicle_id = ? AND ativo = 1',
            [child_vehicle_id, parent_vehicle_id]
        );
        if (reverse.length > 0) {
            return res.status(409).json({ error: 'Vínculo inverso já existe entre estes veículos.' });
        }

        const id = randomUUID();
        await db.query(
            `INSERT INTO vehicle_links (id, parent_vehicle_id, child_vehicle_id, tipo_vinculo, observacao, ativo)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [id, parent_vehicle_id, child_vehicle_id, tipo_vinculo || null, observacao || null]
        );

        if (req.io) req.io.emit('server:sync', { resource: 'vehicles' });
        res.status(201).json({ id, message: 'Veículos atrelados.' });
    } catch (error) {
        console.error('❌ Erro ao criar vínculo:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao atrelar veículos.' });
    }
};

// Desvincula (inativa) — preserva histórico.
const removeLink = async (req, res) => {
    try {
        const [r] = await db.query(
            'UPDATE vehicle_links SET ativo = 0, data_fim = NOW() WHERE id = ? AND ativo = 1',
            [req.params.id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Vínculo não encontrado.' });
        if (req.io) req.io.emit('server:sync', { resource: 'vehicles' });
        res.json({ message: 'Vínculo removido.' });
    } catch (error) {
        console.error('Erro ao remover vínculo:', error);
        res.status(500).json({ error: 'Erro ao remover vínculo.' });
    }
};

module.exports = { listLinks, createLink, removeLink };
