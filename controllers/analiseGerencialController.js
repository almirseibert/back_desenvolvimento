const db = require('../database');
const { processRange, processPlacaDay } = require('../services/discrepanciaService');

// ── Helpers ──────────────────────────────────────────────────────────────────

const parseJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return fallback; }
};

const fmtMin = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m}min`;
    if (!m) return `${h}h`;
    return `${h}h${String(m).padStart(2, '0')}min`;
};

const fmtHora = (iso) => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};

const labelTipo = (tipo) => ({
    maquina_alem_do_faturado: 'Máquina rodou fora do faturado',
    faturado_alem_da_maquina: 'Faturado sem rastreador correspondente',
    sem_lancamento_com_atividade: 'Atividade sem nenhum lançamento',
    gap_ponto_maquina_inicio: 'Operador presente, máquina ainda desligada',
    gap_ponto_maquina_fim: 'Máquina parou antes do operador sair',
}[tipo] || tipo);

const buildNarrativa = (row, discrepancias) => {
    if (!discrepancias.length) return 'Sem discrepâncias relevantes nesse dia.';
    const partes = discrepancias.map(d => {
        const ivs = d.intervalos_envolvidos || [];
        const janelas = ivs.length
            ? ivs.map(iv => `${fmtHora(iv.inicio)}–${fmtHora(iv.fim)}`).join(', ')
            : '';
        const sufixo = janelas ? ` em ${janelas}` : '';
        return `• ${labelTipo(d.tipo)} (${fmtMin(d.magnitude_min)})${sufixo}`;
    });
    return partes.join('\n');
};

// ── GET /api/analise-gerencial/discrepancias/obras ───────────────────────────

const obrasOverview = async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        // Quebra por tipo via JSON_TABLE: 1 linha por (obra, tipo)
        const [porTipo] = await db.query(
            `SELECT a.obra_id,
                    o.nome AS obra_nome,
                    JSON_UNQUOTE(JSON_EXTRACT(d.value, '$.tipo')) AS tipo,
                    SUM(JSON_EXTRACT(d.value, '$.magnitude_min')) AS gap_min,
                    COUNT(*) AS qtd
               FROM analise_dia_maquina a
               JOIN JSON_TABLE(a.discrepancias_json, '$[*]' COLUMNS(value JSON PATH '$')) d
               LEFT JOIN obras o ON o.id = a.obra_id
              WHERE a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              GROUP BY a.obra_id, o.nome, JSON_UNQUOTE(JSON_EXTRACT(d.value, '$.tipo'))`,
            [startDate, endDate]
        );

        // Máquinas envolvidas por obra (distinct vehicles em dias com discrepância)
        const [maqRows] = await db.query(
            `SELECT a.obra_id, COUNT(DISTINCT a.vehicle_id) AS maquinas
               FROM analise_dia_maquina a
              WHERE a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              GROUP BY a.obra_id`,
            [startDate, endDate]
        );

        const obrasMap = new Map();
        for (const r of porTipo) {
            const key = r.obra_id || '__none__';
            if (!obrasMap.has(key)) {
                obrasMap.set(key, {
                    obraId: r.obra_id,
                    obraNome: r.obra_nome || '(Sem obra atribuída)',
                    porTipo: {},
                    totalDiscrepancias: 0,
                    gapAcumuladoMin: 0,
                    maquinasEnvolvidas: 0,
                });
            }
            const obra = obrasMap.get(key);
            obra.porTipo[r.tipo] = { qtd: Number(r.qtd), gap: Number(r.gap_min) };
            obra.totalDiscrepancias += Number(r.qtd);
            obra.gapAcumuladoMin += Number(r.gap_min);
        }
        for (const r of maqRows) {
            const key = r.obra_id || '__none__';
            const obra = obrasMap.get(key);
            if (obra) obra.maquinasEnvolvidas = Number(r.maquinas);
        }

        const obras = [...obrasMap.values()].sort((a, b) => b.gapAcumuladoMin - a.gapAcumuladoMin);
        res.json({ startDate, endDate, obras });
    } catch (e) {
        console.error('Erro obrasOverview:', e);
        res.status(500).json({ error: 'Erro ao agregar obras.' });
    }
};

// ── GET /api/analise-gerencial/discrepancias/obra/:obraId ────────────────────

const obraDetalhe = async (req, res) => {
    const { obraId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    const obraFilter = obraId === '__none__' ? 'a.obra_id IS NULL' : 'a.obra_id = ?';
    const obraParam = obraId === '__none__' ? [] : [obraId];

    try {
        const [linhas] = await db.query(
            `SELECT a.id, a.data, a.vehicle_id, a.employee_id, a.discrepancias_json,
                    a.maior_magnitude_min, a.fontes_disponiveis_json,
                    v.placa, v.registroInterno, v.modelo,
                    e.nome AS employee_nome
               FROM analise_dia_maquina a
               LEFT JOIN vehicles v  ON v.id = a.vehicle_id
               LEFT JOIN employees e ON e.id = a.employee_id
              WHERE ${obraFilter}
                AND a.data BETWEEN ? AND ?
                AND a.justificado_em IS NULL
                AND JSON_LENGTH(a.discrepancias_json) > 0
              ORDER BY a.maior_magnitude_min DESC, a.data DESC
              LIMIT 200`,
            [...obraParam, startDate, endDate]
        );

        const kpis = {
            gapMaquinaAlemFaturadoMin: 0,
            gapFaturadoAlemMaquinaMin: 0,
            gapPontoMaquinaMin: 0,
            diasSemLancamentoComAtividade: 0,
        };
        const porMaquina = new Map();
        const porOperador = new Map();

        const lista = linhas.map(r => {
            const disc = parseJson(r.discrepancias_json, []);
            for (const d of disc) {
                if (d.tipo === 'maquina_alem_do_faturado') kpis.gapMaquinaAlemFaturadoMin += d.magnitude_min;
                if (d.tipo === 'faturado_alem_da_maquina') kpis.gapFaturadoAlemMaquinaMin += d.magnitude_min;
                if (d.tipo === 'sem_lancamento_com_atividade') kpis.diasSemLancamentoComAtividade++;
                if (d.tipo && d.tipo.startsWith('gap_ponto_maquina')) kpis.gapPontoMaquinaMin += d.magnitude_min;
            }
            const totalDoDia = disc.reduce((s, d) => s + d.magnitude_min, 0);
            const placaKey = r.placa || r.vehicle_id;
            porMaquina.set(placaKey, (porMaquina.get(placaKey) || { placa: r.placa, registroInterno: r.registroInterno, min: 0 }));
            porMaquina.get(placaKey).min += totalDoDia;
            if (r.employee_nome) {
                porOperador.set(r.employee_nome, (porOperador.get(r.employee_nome) || 0) + totalDoDia);
            }
            return {
                id: r.id,
                data: r.data,
                placa: r.placa,
                registroInterno: r.registroInterno,
                operadorNome: r.employee_nome,
                maiorMagnitudeMin: r.maior_magnitude_min,
                discrepancias: disc,
            };
        });

        const topMaquinas = [...porMaquina.values()]
            .sort((a, b) => b.min - a.min).slice(0, 5);
        const topOperadores = [...porOperador.entries()]
            .map(([nome, min]) => ({ nome, min }))
            .sort((a, b) => b.min - a.min).slice(0, 5);

        res.json({ kpis, topMaquinas, topOperadores, lista });
    } catch (e) {
        console.error('Erro obraDetalhe:', e);
        res.status(500).json({ error: 'Erro ao montar detalhe da obra.' });
    }
};

// ── GET /api/analise-gerencial/discrepancias/:id ─────────────────────────────

const discrepanciaDrill = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT a.*, v.placa, v.registroInterno, v.modelo,
                    e.nome AS employee_nome,
                    o.nome AS obra_nome,
                    u.name AS justificado_por_nome
               FROM analise_dia_maquina a
               LEFT JOIN vehicles  v ON v.id = a.vehicle_id
               LEFT JOIN employees e ON e.id = a.employee_id
               LEFT JOIN obras     o ON o.id = a.obra_id
               LEFT JOIN users     u ON u.id = a.justificado_por
              WHERE a.id = ?`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Linha não encontrada.' });
        const r = rows[0];
        const discrepancias = parseJson(r.discrepancias_json, []);
        res.json({
            id: r.id,
            data: r.data,
            obraId: r.obra_id,
            obraNome: r.obra_nome,
            placa: r.placa,
            registroInterno: r.registroInterno,
            modelo: r.modelo,
            operadorNome: r.employee_nome,
            fontesDisponiveis: parseJson(r.fontes_disponiveis_json, {}),
            faturadoIntervalos: parseJson(r.faturado_intervalos_json, []),
            rastreadorIntervalos: parseJson(r.rastreador_intervalos_json, []),
            pontoIntervalos: parseJson(r.ponto_intervalos_json, null),
            fonteSinal: r.fonte_sinal,
            discrepancias,
            narrativa: buildNarrativa(r, discrepancias),
            justificadoEm: r.justificado_em,
            justificadoPor: r.justificado_por_nome,
            justificativa: r.justificativa,
        });
    } catch (e) {
        console.error('Erro discrepanciaDrill:', e);
        res.status(500).json({ error: 'Erro ao buscar drill.' });
    }
};

// ── POST /api/analise-gerencial/discrepancias/:id/justificar ─────────────────

const justificar = async (req, res) => {
    const { id } = req.params;
    const { justificativa } = req.body || {};
    if (!justificativa || !justificativa.trim()) {
        return res.status(400).json({ error: 'Justificativa é obrigatória.' });
    }
    try {
        const [r] = await db.query(
            `UPDATE analise_dia_maquina
                SET justificado_em = NOW(),
                    justificado_por = ?,
                    justificativa = ?
              WHERE id = ?`,
            [req.user.id, justificativa.trim(), id]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Linha não encontrada.' });
        res.json({ ok: true });
    } catch (e) {
        console.error('Erro justificar:', e);
        res.status(500).json({ error: 'Erro ao justificar.' });
    }
};

// ── POST /api/analise-gerencial/discrepancias/reprocessar ────────────────────

const reprocessar = async (req, res) => {
    const { startDate, endDate, placa } = req.body || {};
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        if (placa) {
            await db.query(
                'DELETE FROM analise_dia_maquina WHERE data BETWEEN ? AND ? AND justificado_em IS NULL AND vehicle_id IN (SELECT id FROM vehicles WHERE REPLACE(REPLACE(UPPER(placa),"-",""),(" "),"") = REPLACE(REPLACE(UPPER(?),"-",""),(" "),""))',
                [startDate, endDate, placa]
            );
            const result = { processed: 0, discrepancias: 0 };
            const cur = new Date(startDate);
            const end = new Date(endDate);
            while (cur <= end) {
                const d = cur.toISOString().slice(0, 10);
                const r = await processPlacaDay(placa, d);
                if (!r.skipped) {
                    result.processed++;
                    result.discrepancias += r.discrepancias || 0;
                }
                cur.setDate(cur.getDate() + 1);
            }
            return res.json(result);
        }

        await db.query(
            'DELETE FROM analise_dia_maquina WHERE data BETWEEN ? AND ? AND justificado_em IS NULL',
            [startDate, endDate]
        );
        const result = await processRange(startDate, endDate);
        if (req.io) req.io.emit('server:sync', { targets: ['analise-gerencial'] });
        res.json(result);
    } catch (e) {
        console.error('Erro reprocessar análise:', e);
        res.status(500).json({ error: 'Erro ao reprocessar.' });
    }
};

module.exports = {
    obrasOverview,
    obraDetalhe,
    discrepanciaDrill,
    justificar,
    reprocessar,
};
