const db = require('../database');
const { randomUUID } = require('crypto');

const getAll = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM vehicle_type_configs ORDER BY tipo ASC, sub_tipo ASC'
        );
        res.json(rows);
    } catch (err) {
        console.error('[vehicleTypeConfig] getAll:', err);
        res.status(500).json({ error: 'Erro ao buscar configurações de tipos.' });
    }
};

const create = async (req, res) => {
    const { tipo, sub_tipo, media_consumo_padrao, percentual_tolerancia_padrao, unidade } = req.body;
    if (!tipo) return res.status(400).json({ error: 'Campo "tipo" é obrigatório.' });

    const id = randomUUID();
    try {
        await db.query(
            `INSERT INTO vehicle_type_configs
             (id, tipo, sub_tipo, media_consumo_padrao, percentual_tolerancia_padrao, unidade)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                id,
                tipo,
                sub_tipo || null,
                media_consumo_padrao != null ? parseFloat(media_consumo_padrao) : null,
                percentual_tolerancia_padrao != null ? parseFloat(percentual_tolerancia_padrao) : 20.00,
                unidade || 'L/hr',
            ]
        );
        req.io.emit('server:sync', { targets: ['vehicleTypeConfigs'] });
        res.status(201).json({ id, tipo, sub_tipo, media_consumo_padrao, percentual_tolerancia_padrao, unidade });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma configuração para esse tipo/sub-tipo.' });
        }
        console.error('[vehicleTypeConfig] create:', err);
        res.status(500).json({ error: 'Erro ao criar configuração.' });
    }
};

const update = async (req, res) => {
    const { id } = req.params;
    const { tipo, sub_tipo, media_consumo_padrao, percentual_tolerancia_padrao, unidade } = req.body;

    try {
        await db.query(
            `UPDATE vehicle_type_configs SET
             tipo = ?, sub_tipo = ?,
             media_consumo_padrao = ?, percentual_tolerancia_padrao = ?,
             unidade = ?
             WHERE id = ?`,
            [
                tipo,
                sub_tipo || null,
                media_consumo_padrao != null ? parseFloat(media_consumo_padrao) : null,
                percentual_tolerancia_padrao != null ? parseFloat(percentual_tolerancia_padrao) : 20.00,
                unidade || 'L/hr',
                id,
            ]
        );
        req.io.emit('server:sync', { targets: ['vehicleTypeConfigs'] });
        res.json({ message: 'Configuração atualizada com sucesso.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma configuração para esse tipo/sub-tipo.' });
        }
        console.error('[vehicleTypeConfig] update:', err);
        res.status(500).json({ error: 'Erro ao atualizar configuração.' });
    }
};

const remove = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM vehicle_type_configs WHERE id = ?', [id]);
        req.io.emit('server:sync', { targets: ['vehicleTypeConfigs'] });
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTypeConfig] delete:', err);
        res.status(500).json({ error: 'Erro ao excluir configuração.' });
    }
};

module.exports = { getAll, create, update, remove };
