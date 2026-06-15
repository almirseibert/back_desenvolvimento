const db = require('../database');
const { processRange, processPlacaDay } = require('../services/confrontoService');

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

// GET /api/confronto?startDate&endDate&obraId&bucket&placa&page&pageSize
const list = async (req, res) => {
    const { startDate, endDate, obraId, bucket, placa } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(PAGE_SIZE_MAX, parseInt(req.query.pageSize || PAGE_SIZE_DEFAULT, 10));
    const offset = (page - 1) * pageSize;

    try {
        const conditions = ['c.data BETWEEN ? AND ?'];
        const params = [startDate, endDate];
        if (obraId && obraId !== 'all') { conditions.push('c.obra_id = ?'); params.push(obraId); }
        if (bucket) { conditions.push('c.bucket = ?'); params.push(bucket); }
        if (placa) { conditions.push('c.placa = ?'); params.push(placa); }
        const where = 'WHERE ' + conditions.join(' AND ');

        const [counts] = await db.query(
            `SELECT bucket, COUNT(*) AS qtd FROM billing_tracker_confronto c ${where} GROUP BY bucket`,
            params
        );
        const [totalRows] = await db.query(
            `SELECT COUNT(*) AS total FROM billing_tracker_confronto c ${where}`,
            params
        );
        const [rows] = await db.query(
            `SELECT c.id, c.vehicle_id, c.placa, c.data, c.obra_id, c.daily_log_id, c.bucket,
                    c.minutos_atividade_total, c.minutos_dentro_janela, c.minutos_fora_janela,
                    c.fonte_sinal, c.gerado_em,
                    v.registroInterno, v.modelo, v.tipo,
                    o.nome AS obra_nome
             FROM billing_tracker_confronto c
             LEFT JOIN vehicles v ON v.id = c.vehicle_id
             LEFT JOIN obras o ON o.id = c.obra_id
             ${where}
             ORDER BY
               FIELD(c.bucket,'sem_lancamento','atividade_fora_janela','lancamento_sem_rastreio','sem_dados_rastreador','ok'),
               c.data DESC, c.minutos_fora_janela DESC
             LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        );

        res.json({
            page, pageSize,
            total: totalRows[0].total,
            countsByBucket: counts.reduce((a, c) => ({ ...a, [c.bucket]: c.qtd }), {}),
            rows,
        });
    } catch (e) {
        console.error('Erro list confronto:', e);
        res.status(500).json({ error: 'Erro ao listar confronto.' });
    }
};

// GET /api/confronto/:placa/:data
const detail = async (req, res) => {
    const { placa, data } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT c.*, v.registroInterno, v.modelo, v.tipo, o.nome AS obra_nome
             FROM billing_tracker_confronto c
             LEFT JOIN vehicles v ON v.id = c.vehicle_id
             LEFT JOIN obras o ON o.id = c.obra_id
             WHERE c.placa = ? AND c.data = ?`,
            [placa, data]
        );
        if (!rows.length) return res.status(404).json({ error: 'Sem confronto para placa/data.' });
        res.json(rows);
    } catch (e) {
        console.error('Erro detail confronto:', e);
        res.status(500).json({ error: 'Erro ao buscar detalhe.' });
    }
};

// POST /api/confronto/reprocessar { startDate, endDate, placa? }
const reprocess = async (req, res) => {
    const { startDate, endDate, placa } = req.body || {};
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        // Limpa o período antes pra evitar linhas órfãs (placas que perderam atividade)
        if (placa) {
            await db.query(
                'DELETE FROM billing_tracker_confronto WHERE placa = ? AND data BETWEEN ? AND ?',
                [placa, startDate, endDate]
            );
            // Reprocessa dia a dia pra placa específica
            const result = { processed: 0, byBucket: {} };
            const cur = new Date(startDate);
            const end = new Date(endDate);
            while (cur <= end) {
                const d = cur.toISOString().slice(0, 10);
                const r = await processPlacaDay(placa, d);
                if (!r.skipped) {
                    result.processed++;
                    result.byBucket[r.bucket] = (result.byBucket[r.bucket] || 0) + 1;
                }
                cur.setDate(cur.getDate() + 1);
            }
            return res.json(result);
        }

        await db.query(
            'DELETE FROM billing_tracker_confronto WHERE data BETWEEN ? AND ?',
            [startDate, endDate]
        );
        const result = await processRange(startDate, endDate);
        if (req.io) req.io.emit('server:sync', { targets: ['confronto'] });
        res.json(result);
    } catch (e) {
        console.error('Erro reprocess confronto:', e);
        res.status(500).json({ error: 'Erro ao reprocessar.' });
    }
};

module.exports = { list, detail, reprocess };
