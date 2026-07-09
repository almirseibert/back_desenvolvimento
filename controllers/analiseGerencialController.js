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

// ── GET /api/analise-gerencial/jornadas/operador/:employeeId ─────────────────
//
// Relatório de jornadas por operador num período. Agrega o que já está
// materializado em `analise_dia_maquina` cruzando com `daily_work_logs`
// (porque o caminho com-lançamento grava employee_id = NULL na materializada).

const sumIntervalsMin = (intervals) => {
    if (!Array.isArray(intervals) || !intervals.length) return 0;
    let ms = 0;
    for (const iv of intervals) {
        const ini = new Date(iv.inicio).getTime();
        const fim = new Date(iv.fim).getTime();
        if (fim > ini) ms += (fim - ini);
    }
    return Math.round(ms / 60000);
};

const jornadasOperador = async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate e endDate são obrigatórios.' });
    }
    try {
        const [empRows] = await db.query(
            'SELECT id, nome, funcao FROM employees WHERE id = ? LIMIT 1',
            [employeeId]
        );
        if (!empRows.length) return res.status(404).json({ error: 'Operador não encontrado.' });
        const operador = empRows[0];

        const [linhas] = await db.query(
            `SELECT a.id, a.data, a.vehicle_id, a.employee_id, a.obra_id,
                    a.discrepancias_json, a.faturado_intervalos_json,
                    a.rastreador_intervalos_json, a.ponto_intervalos_json,
                    a.fontes_disponiveis_json, a.maior_magnitude_min,
                    a.fonte_sinal, a.justificado_em, a.justificativa,
                    v.placa, v.registroInterno, v.modelo,
                    o.nome AS obra_nome,
                    dwl.employeeId AS dwl_employee_id,
                    dwl.morningStart, dwl.morningEnd,
                    dwl.afternoonStart, dwl.afternoonEnd
               FROM analise_dia_maquina a
               LEFT JOIN vehicles v ON v.id = a.vehicle_id
               LEFT JOIN obras    o ON o.id = a.obra_id
               LEFT JOIN daily_work_logs dwl
                      ON dwl.vehicleId = a.vehicle_id
                     AND dwl.date = a.data
                     AND dwl.employeeId = ?
              WHERE a.data BETWEEN ? AND ?
                AND (
                    a.employee_id = ?
                    OR a.vehicle_id IN (
                        SELECT DISTINCT vehicleId FROM daily_work_logs
                         WHERE employeeId = ? AND date BETWEEN ? AND ?
                    )
                )
              ORDER BY a.data ASC, v.registroInterno ASC`,
            [employeeId, startDate, endDate, employeeId, employeeId, startDate, endDate]
        );

        const totaisMin = { faturado: 0, rastreador: 0, ponto: 0 };
        const fontesGlobais = { faturado: false, rastreador: false, ponto: false };
        let totalDiscrepancias = 0;
        let totalMagnitudeMin = 0;
        const diasMap = new Map();

        for (const r of linhas) {
            const fat = parseJson(r.faturado_intervalos_json, []);
            const ras = parseJson(r.rastreador_intervalos_json, []);
            const pon = parseJson(r.ponto_intervalos_json, null);
            const disc = parseJson(r.discrepancias_json, []);
            const fontes = parseJson(r.fontes_disponiveis_json, {});

            const minFat = sumIntervalsMin(fat);
            const minRas = sumIntervalsMin(ras);
            const minPon = pon ? sumIntervalsMin(pon) : 0;

            totaisMin.faturado += minFat;
            totaisMin.rastreador += minRas;
            totaisMin.ponto += minPon;
            if (fontes.faturado) fontesGlobais.faturado = true;
            if (fontes.rastreador) fontesGlobais.rastreador = true;
            if (fontes.ponto) fontesGlobais.ponto = true;
            totalDiscrepancias += disc.length;
            totalMagnitudeMin += disc.reduce((s, d) => s + (d.magnitude_min || 0), 0);

            const dataStr = r.data instanceof Date
                ? r.data.toISOString().slice(0, 10)
                : String(r.data).slice(0, 10);
            if (!diasMap.has(dataStr)) diasMap.set(dataStr, []);
            diasMap.get(dataStr).push({
                analiseId: r.id,
                vehicleId: r.vehicle_id,
                placa: r.placa,
                registroInterno: r.registroInterno,
                modelo: r.modelo,
                obraId: r.obra_id,
                obraNome: r.obra_nome,
                faturadoIntervalos: fat,
                rastreadorIntervalos: ras,
                pontoIntervalos: pon,
                totaisMin: { faturado: minFat, rastreador: minRas, ponto: minPon },
                discrepancias: disc,
                maiorMagnitudeMin: r.maior_magnitude_min,
                fonteSinal: r.fonte_sinal,
                fontesDisponiveis: fontes,
                justificadoEm: r.justificado_em,
                justificativa: r.justificativa,
                // marca se esse veículo foi lançado pelo operador no dia (não só alocado)
                lancadoPeloOperador: !!r.dwl_employee_id,
                jornadaLancada: r.dwl_employee_id ? {
                    morningStart: r.morningStart, morningEnd: r.morningEnd,
                    afternoonStart: r.afternoonStart, afternoonEnd: r.afternoonEnd,
                } : null,
            });
        }

        const dias = [...diasMap.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([data, maquinas]) => ({ data, maquinas }));

        res.json({
            operador,
            periodo: { startDate, endDate },
            totaisMin,
            fontesDisponiveis: fontesGlobais,
            resumo: {
                diasComAtividade: dias.length,
                maquinasOperadas: new Set(linhas.map(r => r.vehicle_id)).size,
                totalDiscrepancias,
                totalMagnitudeMin,
            },
            dias,
        });
    } catch (e) {
        console.error('Erro jornadasOperador:', e);
        res.status(500).json({ error: 'Erro ao montar jornadas do operador.' });
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

// ── GET /api/analise-gerencial/projecao/:obraId ──────────────────────────────

const getProjecaoObra = async (req, res) => {
    const { obraId } = req.params;
    try {
        const [[obra]] = await db.query('SELECT * FROM obras WHERE id = ?', [obraId]);
        if (!obra) return res.status(404).json({ error: 'Obra não encontrada.' });

        const horasContratadasPorTipo = parseJson(obra.horasContratadasPorTipo, {});
        const valoresPorTipo         = parseJson(obra.valoresPorTipo, {});
        const horasContratadas = Object.values(horasContratadasPorTipo)
            .reduce((a, b) => a + (parseFloat(b) || 0), 0);

        // Logs diários: horas por (data, tipo de veículo)
        const [logRows] = await db.query(`
            SELECT DATE_FORMAT(l.date, '%Y-%m-%d') AS data_log,
                   v.tipo                          AS tipo_veiculo,
                   SUM(l.totalHours)               AS horas
              FROM daily_work_logs l
              LEFT JOIN vehicles v ON v.id = l.vehicleId
             WHERE l.obraId = ?
             GROUP BY data_log, tipo_veiculo
             ORDER BY data_log ASC
        `, [obraId]);

        // Agrupa por data
        const porData = {};
        logRows.forEach(r => {
            const d = r.data_log;
            if (!porData[d]) porData[d] = [];
            porData[d].push({ tipo: r.tipo_veiculo, horas: parseFloat(r.horas) || 0 });
        });

        const todasDatas = Object.keys(porData).sort();
        const dataInicio = todasDatas[0] || null;

        // Totais acumulados
        let totalHoras = 0;
        let totalFaturamentoRS = 0;
        let temValores = false;
        todasDatas.forEach(d => {
            porData[d].forEach(e => {
                totalHoras += e.horas;
                const preco = parseFloat(valoresPorTipo[e.tipo] || valoresPorTipo[e.tipo?.trim()] || 0);
                if (preco > 0) temValores = true;
                totalFaturamentoRS += e.horas * preco;
            });
        });

        // Quinzenas: janelas fixas de 15 dias a partir da data de início operacional
        const quinzenas = [];
        if (dataInicio) {
            const today = new Date().toISOString().slice(0, 10);
            let horasAcum = 0;
            let faturAcum = 0;

            const inicioMs = new Date(dataInicio + 'T12:00:00').getTime();
            const hojeMs   = new Date(today + 'T12:00:00').getTime();
            const maxQuinzenas = Math.min(
                60,
                Math.max(1, Math.floor((hojeMs - inicioMs) / (15 * 24 * 60 * 60 * 1000)) + 1)
            );

            for (let q = 0; q < maxQuinzenas; q++) {
                const ini = new Date(dataInicio + 'T12:00:00');
                ini.setDate(ini.getDate() + q * 15);
                const fim = new Date(ini);
                fim.setDate(fim.getDate() + 14);

                const iniStr = ini.toISOString().slice(0, 10);
                const fimStr = fim.toISOString().slice(0, 10);

                if (iniStr > today) break;

                const datasNaQ = todasDatas.filter(d => d >= iniStr && d <= fimStr);
                let horasQ = 0;
                let faturQ = 0;
                datasNaQ.forEach(d => {
                    porData[d].forEach(e => {
                        horasQ += e.horas;
                        const preco = parseFloat(valoresPorTipo[e.tipo] || 0);
                        faturQ += e.horas * preco;
                    });
                });

                horasAcum += horasQ;
                faturAcum += faturQ;

                const percentAcum  = horasContratadas > 0 ? (horasAcum  / horasContratadas) * 100 : 0;
                const deltaPercent = horasContratadas > 0 ? (horasQ     / horasContratadas) * 100 : 0;

                quinzenas.push({
                    numero:            q + 1,
                    dataInicio:        iniStr,
                    dataFim:           fimStr,
                    horasLancadas:     Math.round(horasQ  * 10) / 10,
                    faturamentoRS:     Math.round(faturQ  * 100) / 100,
                    percentualAcumulado: Math.round(percentAcum  * 10) / 10,
                    deltaPercent:      Math.round(deltaPercent * 10) / 10,
                    atingiuMeta:       deltaPercent >= 30,
                    encerrada:         fimStr < today,
                    excedeuContratado: horasContratadas > 0 && horasAcum > horasContratadas,
                });
            }
        }

        // Ritmo e projeção de prazo
        const diasComLancamento = todasDatas.length;
        const ritmoHorasPorDia  = diasComLancamento > 0 ? totalHoras / diasComLancamento : 0;
        const horasRestantes    = Math.max(0, horasContratadas - totalHoras);
        const diasParaFinalizar = ritmoHorasPorDia > 0 ? Math.ceil(horasRestantes / ritmoHorasPorDia) : null;
        const percentConcluido  = horasContratadas > 0 ? (totalHoras / horasContratadas) * 100 : 0;

        // Custo de combustível (diesel) vinculado à obra.
        // Abastecimentos feitos pelo Comboio ("saída") são gravados em `refuelings`
        // com pricePerLiter = 0 — o custo real fica registrado na "entrada" (quando
        // o comboio se abasteceu no posto), que pode ter obraId diferente (ou nulo).
        // Por isso o custo dessas saídas precisa ser resgatado a partir do preço
        // pago na entrada do comboio mais próxima (na data) que a antecedeu.
        const [refuelRows] = await db.query(`
            SELECT r.authNumber, r.litrosLiberados, r.pricePerLiter
              FROM refuelings r
             WHERE r.obraId = ?
               AND r.litrosLiberados IS NOT NULL
               AND r.pricePerLiter  IS NOT NULL
        `, [obraId]);

        const authNumbers = [...new Set(refuelRows.map(r => r.authNumber).filter(a => a != null))];

        const saidaByAuth = new Map();
        if (authNumbers.length) {
            const placeholders = authNumbers.map(() => '?').join(',');
            const [saidaRows] = await db.query(`
                SELECT authNumber, comboioVehicleId, date
                  FROM comboio_transactions
                 WHERE type = 'saida' AND authNumber IN (${placeholders})
            `, authNumbers);
            saidaRows.forEach(s => saidaByAuth.set(s.authNumber, s));
        }

        const comboioIds = [...new Set([...saidaByAuth.values()].map(s => s.comboioVehicleId).filter(Boolean))];

        const entradasPorComboio = new Map(); // comboioVehicleId -> [{ ts, price }] ordenado por data
        if (comboioIds.length) {
            const placeholders = comboioIds.map(() => '?').join(',');
            const [entradaRows] = await db.query(`
                SELECT r.vehicleId AS comboioVehicleId, r.data AS date, r.pricePerLiter
                  FROM refuelings r
                  JOIN comboio_transactions ct ON ct.authNumber = r.authNumber AND ct.type = 'entrada'
                 WHERE r.vehicleId IN (${placeholders})
                   AND r.pricePerLiter IS NOT NULL
                   AND r.pricePerLiter > 0
                 ORDER BY r.data ASC
            `, comboioIds);
            entradaRows.forEach(e => {
                if (!entradasPorComboio.has(e.comboioVehicleId)) entradasPorComboio.set(e.comboioVehicleId, []);
                entradasPorComboio.get(e.comboioVehicleId).push({
                    ts:    new Date(e.date).getTime(),
                    price: parseFloat(e.pricePerLiter) || 0,
                });
            });
        }

        // Preço vigente do comboio numa data: última entrada com data <= saída;
        // se a saída for anterior a qualquer entrada registrada, usa a mais antiga disponível.
        const precoComboioNaData = (comboioVehicleId, dataSaida) => {
            const lista = entradasPorComboio.get(comboioVehicleId);
            if (!lista || !lista.length) return 0;
            const alvo = new Date(dataSaida).getTime();
            let melhor = null;
            for (const e of lista) {
                if (e.ts <= alvo) melhor = e;
                else break;
            }
            return melhor ? melhor.price : lista[0].price;
        };

        let totalLitros = 0;
        let totalCustoCombust = 0;
        refuelRows.forEach(r => {
            const litros = parseFloat(r.litrosLiberados) || 0;
            totalLitros += litros;

            const saida = saidaByAuth.get(r.authNumber);
            const preco = saida
                ? precoComboioNaData(saida.comboioVehicleId, saida.date)
                : (parseFloat(r.pricePerLiter) || 0);

            totalCustoCombust += litros * preco;
        });

        // % combustível sobre faturamento já realizado
        const percentCombust = totalFaturamentoRS > 0
            ? (totalCustoCombust / totalFaturamentoRS) * 100
            : 0;

        // Projeção linear: se hoje X% está concluído e gastamos Y% em combustível,
        // a 100% de conclusão a tendência é gastar Y/X * 100 em combustível.
        const projecaoFinalPercent = percentConcluido > 1
            ? (percentCombust / percentConcluido) * 100
            : percentCombust;

        res.json({
            obra: {
                id:               obra.id,
                nome:             obra.nome,
                contractType:     obra.contractType || 'horas',
                horasContratadas,
                temValoresPorTipo: temValores,
                dataInicio,
            },
            faturamento: {
                totalHorasFaturadas:  Math.round(totalHoras          * 10)  / 10,
                totalRS:              Math.round(totalFaturamentoRS   * 100) / 100,
                percentualConcluido:  Math.round(percentConcluido     * 10)  / 10,
                ritmoHorasPorDia:     Math.round(ritmoHorasPorDia     * 10)  / 10,
                diasParaFinalizar,
                diasComLancamento,
                quinzenas,
            },
            combustivel: {
                totalLitros:           Math.round(totalLitros        * 10)  / 10,
                totalCustoRS:          Math.round(totalCustoCombust  * 100) / 100,
                percentualAtual:       Math.round(percentCombust     * 10)  / 10,
                projecaoFinalPercent:  Math.round(projecaoFinalPercent * 10) / 10,
                alertaCritico:         projecaoFinalPercent > 20,
                semDados:              totalLitros === 0,
            },
        });
    } catch (e) {
        console.error('[projecaoObra]', e);
        res.status(500).json({ error: 'Erro ao calcular projeção da obra.' });
    }
};

module.exports = {
    obrasOverview,
    obraDetalhe,
    discrepanciaDrill,
    justificar,
    reprocessar,
    jornadasOperador,
    getProjecaoObra,
};
