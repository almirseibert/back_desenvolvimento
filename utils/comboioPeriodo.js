// utils/comboioPeriodo.js
// Gerencia o histórico de "estadias" de cada veículo-comboio em obras.
// Cada vez que o comboio muda de obra abrimos um novo período (e fechamos
// o anterior). Transações do comboio (entrada/saída/drenagem) carregam
// `obra_periodo_id` para serem agregadas por estadia.

const crypto = require('crypto');

const TABLE = 'comboio_periodos_obra';

// Retorna o período ATIVO do comboio (ou null).
const getActivePeriod = async (dbClient, comboioId) => {
    if (!comboioId) return null;
    const [rows] = await dbClient.query(
        `SELECT * FROM ${TABLE} WHERE comboio_id = ? AND ativo = 1 ORDER BY data_inicio DESC LIMIT 1`,
        [comboioId]
    );
    return rows[0] || null;
};

const getActivePeriodId = async (dbClient, comboioId) => {
    const p = await getActivePeriod(dbClient, comboioId);
    return p ? p.id : null;
};

// Fecha qualquer período ativo do comboio (idempotente).
const closeActivePeriod = async (dbClient, comboioId, endDate = new Date()) => {
    if (!comboioId) return 0;
    const [result] = await dbClient.query(
        `UPDATE ${TABLE} SET ativo = 0, data_fim = ? WHERE comboio_id = ? AND ativo = 1`,
        [endDate, comboioId]
    );
    return result.affectedRows || 0;
};

// Abre um novo período para a obra atual.
// Se já existe período ATIVO para essa mesma obra, não duplica.
// Se existe período ativo para outra obra, fecha antes de abrir.
const openPeriod = async (dbClient, comboioId, obraId, startDate = new Date()) => {
    if (!comboioId || !obraId) return null;
    const current = await getActivePeriod(dbClient, comboioId);
    if (current && String(current.obra_id) === String(obraId)) {
        return { id: current.id, created: false, reused: true };
    }
    if (current) {
        await closeActivePeriod(dbClient, comboioId, startDate);
    }
    const id = crypto.randomUUID();
    await dbClient.query(
        `INSERT INTO ${TABLE} (id, comboio_id, obra_id, data_inicio, ativo) VALUES (?, ?, ?, ?, 1)`,
        [id, comboioId, obraId, startDate]
    );
    return { id, created: true, reused: false };
};

// Idempotente: garante que existe um período ativo para o comboio na obra atual.
// Usado pelo backfill (na inicialização) e como rede de segurança.
const ensureOpenComboioPeriod = async (dbClient, comboioId, obraId) => {
    if (!comboioId || !obraId) return null;
    const current = await getActivePeriod(dbClient, comboioId);
    if (current && String(current.obra_id) === String(obraId)) {
        return { id: current.id, created: false };
    }
    return openPeriod(dbClient, comboioId, obraId);
};

// Lista todos os períodos de um comboio (mais recente primeiro).
const listPeriods = async (dbClient, comboioId) => {
    if (!comboioId) return [];
    const [rows] = await dbClient.query(
        `SELECT p.*, o.nome AS obra_nome
         FROM ${TABLE} p
         LEFT JOIN obras o ON o.id = p.obra_id
         WHERE p.comboio_id = ?
         ORDER BY p.data_inicio DESC`,
        [comboioId]
    );
    return rows;
};

module.exports = {
    getActivePeriod,
    getActivePeriodId,
    closeActivePeriod,
    openPeriod,
    ensureOpenComboioPeriod,
    listPeriods,
};
