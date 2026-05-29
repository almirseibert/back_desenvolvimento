const db = require('../database');
const { randomUUID } = require('crypto');

const UNIDADES_VALIDAS = ['L/h', 'h/L', 'Km/L', 'L/Km'];

const emitSync = (req) => req.io && req.io.emit('server:sync', { targets: ['vehicleTaxonomy'] });

// ── Árvore completa ─────────────────────────────────────────────────────────
const getTree = async (req, res) => {
    try {
        const [groups] = await db.query('SELECT * FROM vehicle_groups ORDER BY ordem ASC, nome ASC');
        const [types] = await db.query('SELECT * FROM vehicle_types ORDER BY nome ASC');
        const [subTypes] = await db.query('SELECT * FROM vehicle_sub_types ORDER BY nome ASC');

        const subByType = {};
        subTypes.forEach(s => {
            (subByType[s.type_id] = subByType[s.type_id] || []).push({ id: s.id, nome: s.nome });
        });
        const typesByGroup = {};
        types.forEach(t => {
            (typesByGroup[t.group_id] = typesByGroup[t.group_id] || []).push({
                id: t.id, nome: t.nome, subTipos: subByType[t.id] || [],
            });
        });

        const tree = groups.map(g => ({
            id: g.id,
            nome: g.nome,
            unidade: g.unidade,
            ordem: g.ordem,
            tipos: typesByGroup[g.id] || [],
        }));
        res.json(tree);
    } catch (err) {
        console.error('[vehicleTaxonomy] getTree:', err);
        res.status(500).json({ error: 'Erro ao buscar taxonomia de veículos.' });
    }
};

// ── Grupos ──────────────────────────────────────────────────────────────────
const createGroup = async (req, res) => {
    const { nome, unidade } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do grupo é obrigatório.' });
    const uni = UNIDADES_VALIDAS.includes(unidade) ? unidade : 'L/h';
    const id = randomUUID();
    try {
        const [[{ maxOrdem }]] = await db.query('SELECT COALESCE(MAX(ordem), -1) AS maxOrdem FROM vehicle_groups');
        await db.query('INSERT INTO vehicle_groups (id, nome, unidade, ordem) VALUES (?, ?, ?, ?)',
            [id, nome, uni, maxOrdem + 1]);
        emitSync(req);
        res.status(201).json({ id, nome, unidade: uni });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um grupo com esse nome.' });
        console.error('[vehicleTaxonomy] createGroup:', err);
        res.status(500).json({ error: 'Erro ao criar grupo.' });
    }
};

const updateGroup = async (req, res) => {
    const { id } = req.params;
    const { nome, unidade } = req.body;
    if (unidade && !UNIDADES_VALIDAS.includes(unidade)) {
        return res.status(400).json({ error: 'Unidade inválida.' });
    }
    try {
        const [[current]] = await db.query('SELECT * FROM vehicle_groups WHERE id = ?', [id]);
        if (!current) return res.status(404).json({ error: 'Grupo não encontrado.' });
        await db.query('UPDATE vehicle_groups SET nome = ?, unidade = ? WHERE id = ?',
            [nome != null ? nome : current.nome, unidade || current.unidade, id]);
        emitSync(req);
        res.json({ message: 'Grupo atualizado.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um grupo com esse nome.' });
        console.error('[vehicleTaxonomy] updateGroup:', err);
        res.status(500).json({ error: 'Erro ao atualizar grupo.' });
    }
};

const deleteGroup = async (req, res) => {
    const { id } = req.params;
    try {
        const [tipos] = await db.query('SELECT nome FROM vehicle_types WHERE group_id = ?', [id]);
        if (tipos.length > 0) {
            const inUse = await typesInUse(tipos.map(t => t.nome));
            if (inUse.length > 0) {
                return res.status(409).json({ error: `Não é possível excluir: há veículos usando os tipos: ${inUse.join(', ')}.` });
            }
        }
        await db.query('DELETE FROM vehicle_groups WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteGroup:', err);
        res.status(500).json({ error: 'Erro ao excluir grupo.' });
    }
};

// ── Tipos ───────────────────────────────────────────────────────────────────
const createType = async (req, res) => {
    const { group_id, nome } = req.body;
    if (!group_id || !nome) return res.status(400).json({ error: 'group_id e nome são obrigatórios.' });
    const id = randomUUID();
    try {
        await db.query('INSERT INTO vehicle_types (id, group_id, nome) VALUES (?, ?, ?)', [id, group_id, nome]);
        emitSync(req);
        res.status(201).json({ id, group_id, nome });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse tipo no grupo.' });
        console.error('[vehicleTaxonomy] createType:', err);
        res.status(500).json({ error: 'Erro ao criar tipo.' });
    }
};

const updateType = async (req, res) => {
    const { id } = req.params;
    const { nome, group_id } = req.body;
    try {
        const [[current]] = await db.query('SELECT * FROM vehicle_types WHERE id = ?', [id]);
        if (!current) return res.status(404).json({ error: 'Tipo não encontrado.' });
        await db.query('UPDATE vehicle_types SET nome = ?, group_id = ? WHERE id = ?',
            [nome != null ? nome : current.nome, group_id || current.group_id, id]);
        emitSync(req);
        res.json({ message: 'Tipo atualizado.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse tipo no grupo.' });
        console.error('[vehicleTaxonomy] updateType:', err);
        res.status(500).json({ error: 'Erro ao atualizar tipo.' });
    }
};

const deleteType = async (req, res) => {
    const { id } = req.params;
    try {
        const [[tipo]] = await db.query('SELECT nome FROM vehicle_types WHERE id = ?', [id]);
        if (tipo) {
            const inUse = await typesInUse([tipo.nome]);
            if (inUse.length > 0) {
                return res.status(409).json({ error: `Não é possível excluir: há veículos usando o tipo "${tipo.nome}".` });
            }
        }
        await db.query('DELETE FROM vehicle_types WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteType:', err);
        res.status(500).json({ error: 'Erro ao excluir tipo.' });
    }
};

// ── Sub-tipos ───────────────────────────────────────────────────────────────
const createSubType = async (req, res) => {
    const { type_id, nome } = req.body;
    if (!type_id || !nome) return res.status(400).json({ error: 'type_id e nome são obrigatórios.' });
    const id = randomUUID();
    try {
        await db.query('INSERT INTO vehicle_sub_types (id, type_id, nome) VALUES (?, ?, ?)', [id, type_id, nome]);
        emitSync(req);
        res.status(201).json({ id, type_id, nome });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse sub-tipo no tipo.' });
        console.error('[vehicleTaxonomy] createSubType:', err);
        res.status(500).json({ error: 'Erro ao criar sub-tipo.' });
    }
};

const updateSubType = async (req, res) => {
    const { id } = req.params;
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        await db.query('UPDATE vehicle_sub_types SET nome = ? WHERE id = ?', [nome, id]);
        emitSync(req);
        res.json({ message: 'Sub-tipo atualizado.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe esse sub-tipo no tipo.' });
        console.error('[vehicleTaxonomy] updateSubType:', err);
        res.status(500).json({ error: 'Erro ao atualizar sub-tipo.' });
    }
};

const deleteSubType = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM vehicle_sub_types WHERE id = ?', [id]);
        emitSync(req);
        res.status(204).end();
    } catch (err) {
        console.error('[vehicleTaxonomy] deleteSubType:', err);
        res.status(500).json({ error: 'Erro ao excluir sub-tipo.' });
    }
};

// ── Auxiliar: quais tipos (por nome) estão em uso por veículos ────────────────
const typesInUse = async (nomes) => {
    if (!nomes || nomes.length === 0) return [];
    const placeholders = nomes.map(() => '?').join(',');
    try {
        const [rows] = await db.query(
            `SELECT DISTINCT tipo FROM vehicles WHERE tipo IN (${placeholders})`,
            nomes
        );
        return rows.map(r => r.tipo);
    } catch (err) {
        console.warn('[vehicleTaxonomy] typesInUse:', err.message);
        return [];
    }
};

module.exports = {
    getTree,
    createGroup, updateGroup, deleteGroup,
    createType, updateType, deleteType,
    createSubType, updateSubType, deleteSubType,
};
