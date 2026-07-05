const db = require('../database');

// Relatório de entradas e saídas de volume de combustível de um comboio.
// Filtros: comboioVehicleId (obrigatório), from, to (datas), fuelType (opcional),
// obraId (opcional — filtra o detalhamento de saídas por obra abastecida).
//
// Regra de saldo (nível tanque físico do comboio):
//   saldoInicial = Σ entradas − Σ saídas ANTES de `from`
//   saldoFinal   = saldoInicial + entradas(período) − saídas(período)
// O filtro fuelType, quando informado, se aplica a todo o cálculo (comboio pode
// carregar mais de um combustível). O filtro obraId afeta apenas o detalhamento
// por obra (o tanque é físico e não pertence a uma obra).
const getReport = async (req, res) => {
    try {
        const { comboioVehicleId, from, to, fuelType, obraId } = req.query;
        if (!comboioVehicleId) return res.status(400).json({ error: 'comboioVehicleId é obrigatório.' });
        if (!from || !to) return res.status(400).json({ error: 'Datas inicial e final são obrigatórias.' });

        const fuelCond = fuelType ? ' AND fuelType = ?' : '';
        const fuelParam = fuelType ? [fuelType] : [];

        // 1) Saldo inicial (tudo antes de `from`)
        const [ini] = await db.query(
            `SELECT
                COALESCE(SUM(CASE WHEN type = 'entrada' THEN liters ELSE 0 END), 0) AS entradas,
                COALESCE(SUM(CASE WHEN type = 'saida'   THEN liters ELSE 0 END), 0) AS saidas
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date < ?${fuelCond}`,
            [comboioVehicleId, from, ...fuelParam]
        );
        const saldoInicial = Number(ini[0].entradas) - Number(ini[0].saidas);

        // 2) Totais do período
        const [per] = await db.query(
            `SELECT
                COALESCE(SUM(CASE WHEN type = 'entrada' THEN liters ELSE 0 END), 0) AS entradas,
                COALESCE(SUM(CASE WHEN type = 'saida'   THEN liters ELSE 0 END), 0) AS saidas
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date >= ? AND date <= ?${fuelCond}`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam]
        );
        const totalEntradas = Number(per[0].entradas);
        const totalSaidas = Number(per[0].saidas);
        const saldoFinal = saldoInicial + totalEntradas - totalSaidas;

        // 3) Detalhamento de saídas por obra no período
        const obraCond = obraId ? ' AND obraId = ?' : '';
        const obraParam = obraId ? [obraId] : [];
        const [porObra] = await db.query(
            `SELECT obraId, obraName, COALESCE(SUM(liters), 0) AS litros, COUNT(*) AS qtd
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND type = 'saida' AND date >= ? AND date <= ?${fuelCond}${obraCond}
             GROUP BY obraId, obraName
             ORDER BY litros DESC`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam, ...obraParam]
        );

        // 4) Transações do período (listagem)
        const [transacoes] = await db.query(
            `SELECT id, type, date, liters, fuelType, obraId, obraName,
                    receivingVehicleName, partnerName, invoiceNumber
             FROM comboio_transactions
             WHERE comboioVehicleId = ? AND date >= ? AND date <= ?${fuelCond}${obraCond}
             ORDER BY date ASC`,
            [comboioVehicleId, from, to + ' 23:59:59', ...fuelParam, ...obraParam]
        );

        res.json({
            comboioVehicleId,
            from, to, fuelType: fuelType || null, obraId: obraId || null,
            saldoInicial,
            totalEntradas,
            totalSaidas,
            saldoFinal,
            porObra: porObra.map(o => ({ ...o, litros: Number(o.litros), qtd: Number(o.qtd) })),
            transacoes,
        });
    } catch (error) {
        console.error('❌ Erro no relatório de comboio:', error.code, '|', error.sqlMessage || error.message);
        res.status(500).json({ error: 'Erro ao gerar relatório de comboio.' });
    }
};

module.exports = { getReport };
