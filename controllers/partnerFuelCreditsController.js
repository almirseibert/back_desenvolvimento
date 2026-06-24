// controllers/partnerFuelCreditsController.js
// Saldo pré-pago em postos: lança créditos, mostra saldo, extrato e ajustes.

const db = require('../database');
const { insertEntry, getBalance } = require('../utils/partnerFuelCredits');

// Lista todos os postos com saldo (mesmo zerados) + ordens em aberto sem valor.
const listBalances = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                p.id            AS partner_id,
                p.razaoSocial   AS partner_name,
                p.tipo_parceiro AS partner_type,
                COALESCE(b.total_credited,   0) AS total_credited,
                COALESCE(b.total_reserved,   0) AS total_reserved,
                COALESCE(b.total_settled,    0) AS total_settled,
                COALESCE(b.total_adjustment, 0) AS total_adjustment,
                COALESCE(b.available,        0) AS available,
                (SELECT COUNT(*) FROM refuelings r
                   WHERE r.partnerId = p.id
                     AND r.is_full_tank = 1
                     AND r.status NOT IN ('Concluída','Concluida','Cancelada','Negada','Baixada')) AS full_tank_open,
                (SELECT COUNT(*) FROM refuelings r
                   WHERE r.partnerId = p.id
                     AND r.reserved_amount IS NULL AND r.is_full_tank = 0
                     AND r.status NOT IN ('Concluída','Concluida','Cancelada','Negada','Baixada')) AS no_value_open
              FROM partners p
              LEFT JOIN v_partner_fuel_balance b ON b.partner_id = p.id
             WHERE p.tipo_parceiro = 'posto'
             ORDER BY p.razaoSocial
        `);
        res.json(rows);
    } catch (error) {
        console.error('❌ [partnerFuelCredits] listBalances:', error);
        res.status(500).json({ error: 'Falha ao listar saldos.' });
    }
};

// Detalhe de um posto: saldo + consumo médio (30/60/90d) + ordens em aberto.
const getPartnerDetail = async (req, res) => {
    const { partnerId } = req.params;
    try {
        const [[partner]] = await db.execute(
            'SELECT id, razaoSocial, tipo_parceiro FROM partners WHERE id = ?',
            [partnerId]
        );
        if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado.' });

        const balance = await getBalance(partnerId);

        // Consumo médio diário em valor (R$) — baseado nas baixas (settlement).
        const [[consumo]] = await db.execute(`
            SELECT
                COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount ELSE 0 END), 0) AS d30,
                COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN amount ELSE 0 END), 0) AS d60,
                COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN amount ELSE 0 END), 0) AS d90
              FROM partner_fuel_credit_entries
             WHERE partner_id = ? AND entry_type = 'settlement'
        `, [partnerId]);

        const avg30 = Number(consumo.d30) / 30;
        const avg60 = Number(consumo.d60) / 60;
        const avg90 = Number(consumo.d90) / 90;
        const available = Number(balance.available) || 0;
        const diasEstimados = avg30 > 0 ? Math.floor(available / avg30) : null;

        res.json({
            partner,
            balance,
            consumption: {
                last30Days: Number(consumo.d30),
                last60Days: Number(consumo.d60),
                last90Days: Number(consumo.d90),
                avgDaily30: avg30,
                avgDaily60: avg60,
                avgDaily90: avg90,
                estimatedDaysLeft: diasEstimados,
            },
        });
    } catch (error) {
        console.error('❌ [partnerFuelCredits] getPartnerDetail:', error);
        res.status(500).json({ error: 'Falha ao buscar detalhe do parceiro.' });
    }
};

// Extrato paginado.
const getEntries = async (req, res) => {
    const { partnerId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    try {
        const [rows] = await db.query(
            `SELECT e.*,
                    u.email AS created_by_email,
                    r.authNumber AS order_auth_number,
                    r.is_full_tank AS order_is_full_tank,
                    r.status AS order_status,
                    o.nome AS obra_name
               FROM partner_fuel_credit_entries e
               LEFT JOIN users u      ON u.id = e.created_by
               LEFT JOIN refuelings r ON r.id = e.order_id
               LEFT JOIN obras o      ON o.id = e.obra_id
              WHERE e.partner_id = ?
              ORDER BY e.created_at DESC, e.id DESC
              LIMIT ? OFFSET ?`,
            [partnerId, limit, offset]
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ [partnerFuelCredits] getEntries:', error);
        res.status(500).json({ error: 'Falha ao buscar extrato.' });
    }
};

// Lança um crédito (entrada de dinheiro).
const createCredit = async (req, res) => {
    const { partner_id, amount, description } = req.body;
    const value = Number(amount);
    if (!partner_id || !Number.isFinite(value) || value <= 0) {
        return res.status(400).json({ error: 'partner_id e amount (>0) são obrigatórios.' });
    }
    try {
        const [[partner]] = await db.execute(
            'SELECT id, tipo_parceiro FROM partners WHERE id = ?',
            [partner_id]
        );
        if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado.' });
        if (partner.tipo_parceiro !== 'posto') {
            return res.status(400).json({ error: 'Saldo pré-pago só é controlado para postos.' });
        }

        await insertEntry(null, {
            partnerId: partner_id,
            entryType: 'credit',
            amount: value,
            description: description || 'Crédito lançado',
            createdBy: req.user?.id || null,
        });

        if (req.io) req.io.emit('server:sync', { targets: ['partner_fuel_credits'] });
        res.status(201).json({ message: 'Crédito lançado com sucesso.' });
    } catch (error) {
        console.error('❌ [partnerFuelCredits] createCredit:', error);
        res.status(500).json({ error: 'Falha ao lançar crédito.' });
    }
};

// Ajuste manual (estorno/correção). amount pode ser negativo.
const createAdjustment = async (req, res) => {
    const { partnerId } = req.params;
    const { amount, description } = req.body;
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) {
        return res.status(400).json({ error: 'amount (≠ 0) é obrigatório.' });
    }
    if (!description || !description.trim()) {
        return res.status(400).json({ error: 'description é obrigatório para ajustes.' });
    }
    try {
        await insertEntry(null, {
            partnerId,
            entryType: 'adjustment',
            amount: value,
            description,
            createdBy: req.user?.id || null,
        });
        if (req.io) req.io.emit('server:sync', { targets: ['partner_fuel_credits'] });
        res.status(201).json({ message: 'Ajuste lançado com sucesso.' });
    } catch (error) {
        console.error('❌ [partnerFuelCredits] createAdjustment:', error);
        res.status(500).json({ error: 'Falha ao lançar ajuste.' });
    }
};

module.exports = {
    listBalances,
    getPartnerDetail,
    getEntries,
    createCredit,
    createAdjustment,
};
