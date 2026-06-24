// utils/partnerFuelCredits.js
// Helpers para movimentar o saldo pré-pago de combustível por parceiro (posto).
// Usado tanto pelo controller dedicado quanto pelos hooks do refuelingController.

const db = require('../database');

/**
 * Insere um lançamento no extrato. Aceita uma connection (para usar dentro de
 * transação já aberta no chamador) ou usa o pool diretamente.
 */
const insertEntry = async (conn, {
    partnerId,
    entryType,
    amount,
    orderId = null,
    obraId = null,
    description = null,
    createdBy = null,
}) => {
    if (!partnerId || !entryType) return;
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount)) return;
    // amount=0 é permitido (usado para registrar ordem "encher tanque" no extrato sem afetar saldo)
    const exec = conn || db;
    const createdByStr = createdBy === null || createdBy === undefined ? null : String(createdBy);
    await exec.execute(
        `INSERT INTO partner_fuel_credit_entries
            (partner_id, entry_type, amount, order_id, obra_id, description, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [partnerId, entryType, numAmount, orderId, obraId, description, createdByStr]
    );
};

/**
 * Último preço praticado em uma ordem de abastecimento concluída no posto.
 * Fallback: preço cadastrado em partner_fuel_prices. Retorna 0 se nada achar.
 */
const getLastPriceForPartner = async (conn, partnerId, fuelType) => {
    if (!partnerId || !fuelType) return 0;
    const exec = conn || db;
    const [rows] = await exec.execute(
        `SELECT pricePerLiter FROM refuelings
          WHERE partnerId = ? AND fuelType = ? AND status = 'Concluída' AND pricePerLiter > 0
          ORDER BY data DESC LIMIT 1`,
        [partnerId, fuelType]
    );
    if (rows.length > 0 && Number(rows[0].pricePerLiter) > 0) {
        return Number(rows[0].pricePerLiter);
    }
    const [priceRows] = await exec.execute(
        `SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ? LIMIT 1`,
        [partnerId, fuelType]
    );
    return priceRows.length > 0 ? Number(priceRows[0].price) || 0 : 0;
};

/**
 * Calcula o valor total real de um abastecimento concluído (combustível + arla + outros).
 */
const computeSettlementAmount = (ref) => {
    const litros   = Number(ref.litrosAbastecidos)     || 0;
    const preco    = Number(ref.pricePerLiter)         || 0;
    const litrosA  = Number(ref.litrosAbastecidosArla) || 0;
    const precoA   = Number(ref.pricePerLiterArla)     || 0;
    const outros   = Number(ref.outrosValor)           || 0;
    return (litros * preco) + (litrosA * precoA) + outros;
};

/**
 * Saldo atual e ordens em aberto de um parceiro.
 */
const getBalance = async (partnerId) => {
    const [rows] = await db.execute(
        'SELECT * FROM v_partner_fuel_balance WHERE partner_id = ?',
        [partnerId]
    );
    const balance = rows[0] || {
        partner_id: partnerId,
        total_credited: 0,
        total_reserved: 0,
        total_settled: 0,
        total_adjustment: 0,
        available: 0,
    };
    const [openRows] = await db.execute(
        `SELECT
            SUM(CASE WHEN is_full_tank = 1 THEN 1 ELSE 0 END) AS full_tank_open,
            SUM(CASE WHEN reserved_amount IS NULL AND is_full_tank = 0 THEN 1 ELSE 0 END) AS no_value_open
           FROM refuelings
          WHERE partnerId = ?
            AND status NOT IN ('Concluída','Concluida','Cancelada','Negada','Baixada')`,
        [partnerId]
    );
    return {
        ...balance,
        full_tank_open: Number(openRows[0]?.full_tank_open || 0),
        no_value_open: Number(openRows[0]?.no_value_open || 0),
    };
};

/**
 * Calcula o valor a empenhar dado litros liberados + tipo combustível + arla + outros.
 * Usa último preço praticado no posto.
 */
const computeReservationAmount = async (conn, ref) => {
    const partnerId = ref.partnerId;
    if (!partnerId) return { amount: 0, price: 0 };
    const litros  = Number(ref.litrosLiberados)     || 0;
    const litrosA = Number(ref.litrosLiberadosArla) || 0;
    const outros  = Number(ref.outrosValor)         || 0;
    const price  = await getLastPriceForPartner(conn, partnerId, ref.fuelType);
    const priceA = ref.needsArla ? await getLastPriceForPartner(conn, partnerId, 'Arla') : 0;
    const amount = (litros * price) + (litrosA * priceA) + outros;
    return { amount: Number(amount.toFixed(2)), price };
};

/**
 * Lança a reserva (empenho) de uma ordem recém-criada/liberada. Atualiza
 * refuelings.reserved_amount/reserved_price/is_full_tank.
 * Skip se status for bloqueado, se for fillUp (sem valor) ou se não houver partnerId.
 */
const applyOrderReservation = async (conn, refueling, { createdBy = null } = {}) => {
    if (!refueling || !refueling.partnerId) return;
    const isFillUp = refueling.isFillUp == 1 || refueling.isFillUp === true;
    if (isFillUp) {
        await conn.execute(
            'UPDATE refuelings SET is_full_tank = 1 WHERE id = ?',
            [refueling.id]
        );
        // Registra marcador no extrato (amount=0 — não afeta saldo, só fica visível).
        await insertEntry(conn, {
            partnerId: refueling.partnerId,
            entryType: 'reservation',
            amount: 0,
            orderId: refueling.id,
            obraId: refueling.obraId,
            description: `Empenho ordem #${refueling.authNumber || ''} — encher tanque (valor em aberto)`.trim(),
            createdBy,
        });
        return;
    }
    const { amount, price } = await computeReservationAmount(conn, refueling);
    if (amount <= 0) return;
    await insertEntry(conn, {
        partnerId: refueling.partnerId,
        entryType: 'reservation',
        amount,
        orderId: refueling.id,
        obraId: refueling.obraId,
        description: `Empenho ordem #${refueling.authNumber || ''}`.trim(),
        createdBy,
    });
    await conn.execute(
        'UPDATE refuelings SET reserved_amount = ?, reserved_price = ? WHERE id = ?',
        [amount, price, refueling.id]
    );
};

/**
 * Libera empenho previamente registrado (cancelamento/edição/baixa).
 * Lê reserved_amount da própria linha. Se for null/0, não faz nada.
 */
const releaseOrderReservation = async (conn, refueling, { createdBy = null, reason = 'Cancelamento' } = {}) => {
    if (!refueling || !refueling.partnerId) return;
    const reserved = Number(refueling.reserved_amount) || 0;
    if (reserved <= 0) return;
    await insertEntry(conn, {
        partnerId: refueling.partnerId,
        entryType: 'reservation_release',
        amount: reserved,
        orderId: refueling.id,
        obraId: refueling.obraId,
        description: `${reason} ordem #${refueling.authNumber || ''}`.trim(),
        createdBy,
    });
    await conn.execute(
        'UPDATE refuelings SET reserved_amount = NULL WHERE id = ?',
        [refueling.id]
    );
};

/**
 * Lança a baixa definitiva (settlement) com o valor real do abastecimento.
 */
const settleOrder = async (conn, refueling, { createdBy = null } = {}) => {
    if (!refueling || !refueling.partnerId) return;
    const amount = computeSettlementAmount(refueling);
    if (amount <= 0) return;
    await insertEntry(conn, {
        partnerId: refueling.partnerId,
        entryType: 'settlement',
        amount,
        orderId: refueling.id,
        obraId: refueling.obraId,
        description: `Baixa ordem #${refueling.authNumber || ''}`.trim(),
        createdBy,
    });
};

module.exports = {
    insertEntry,
    getLastPriceForPartner,
    computeSettlementAmount,
    computeReservationAmount,
    getBalance,
    applyOrderReservation,
    releaseOrderReservation,
    settleOrder,
};
