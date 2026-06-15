const db = require('../database');

const MERGE_GAP_MIN = parseInt(process.env.CONFRONTO_MERGE_GAP_MIN || '15', 10);
const EDGE_TOLERANCE_MIN = parseInt(process.env.CONFRONTO_EDGE_TOLERANCE_MIN || '10', 10);
const MIN_ACTIVITY_MIN = parseInt(process.env.CONFRONTO_MIN_ACTIVITY_MIN || '15', 10);

const MS_PER_MIN = 60_000;

// ── Helpers de intervalo ──────────────────────────────────────────────────────

const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * Funde lista de pontos (timestamps ordenados) em intervalos, agrupando pontos
 * separados por gap ≤ gapMin minutos.
 */
const pointsToIntervals = (timestamps, gapMin = MERGE_GAP_MIN) => {
    if (!timestamps.length) return [];
    const sorted = [...timestamps].sort((a, b) => a - b);
    const gapMs = gapMin * MS_PER_MIN;
    const intervals = [];
    let start = sorted[0];
    let last = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const t = sorted[i];
        if (t - last > gapMs) {
            intervals.push({ inicio: start, fim: last });
            start = t;
        }
        last = t;
    }
    intervals.push({ inicio: start, fim: last });
    return intervals;
};

/** Une intervalos sobrepostos (ou colados) de uma lista. */
const unionIntervals = (intervals) => {
    if (!intervals.length) return [];
    const sorted = [...intervals].sort((a, b) => a.inicio - b.inicio);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        const cur = sorted[i];
        if (cur.inicio <= last.fim) {
            last.fim = Math.max(last.fim, cur.fim);
        } else {
            out.push({ ...cur });
        }
    }
    return out;
};

/**
 * Retorna a parte de `intervals` que NÃO está coberta por `mask`,
 * expandindo `mask` em ±toleranceMin minutos.
 */
const subtractWithTolerance = (intervals, mask, toleranceMin = EDGE_TOLERANCE_MIN) => {
    if (!intervals.length) return [];
    const tolMs = toleranceMin * MS_PER_MIN;
    const expanded = unionIntervals(mask.map(m => ({ inicio: m.inicio - tolMs, fim: m.fim + tolMs })));

    const out = [];
    for (const iv of intervals) {
        let cursors = [{ inicio: iv.inicio, fim: iv.fim }];
        for (const m of expanded) {
            const next = [];
            for (const c of cursors) {
                if (m.fim <= c.inicio || m.inicio >= c.fim) {
                    next.push(c);
                    continue;
                }
                if (m.inicio > c.inicio) next.push({ inicio: c.inicio, fim: Math.min(m.inicio, c.fim) });
                if (m.fim < c.fim) next.push({ inicio: Math.max(m.fim, c.inicio), fim: c.fim });
            }
            cursors = next;
        }
        out.push(...cursors);
    }
    return out.filter(iv => iv.fim > iv.inicio);
};

const sumMinutes = (intervals) =>
    Math.round(intervals.reduce((acc, iv) => acc + (iv.fim - iv.inicio), 0) / MS_PER_MIN);

const serializeIntervals = (intervals) =>
    intervals.map(iv => ({
        inicio: new Date(iv.inicio).toISOString(),
        fim: new Date(iv.fim).toISOString(),
    }));

// ── Construção dos envelopes ──────────────────────────────────────────────────

/**
 * Constrói os intervalos lançados a partir de uma daily_work_log.
 * Retorna até 2 intervalos por log (manhã e tarde).
 */
const buildLogIntervals = (log, dateStr) => {
    const intervals = [];
    const pairs = [
        [log.morningStart, log.morningEnd],
        [log.afternoonStart, log.afternoonEnd],
    ];
    for (const [start, end] of pairs) {
        if (!start || !end) continue;
        const ini = new Date(`${dateStr}T${start}`).getTime();
        let fim = new Date(`${dateStr}T${end}`).getTime();
        if (fim <= ini) fim += 24 * 60 * MS_PER_MIN;
        intervals.push({ inicio: ini, fim });
    }
    return intervals;
};

// ── Sinal de atividade ────────────────────────────────────────────────────────

/**
 * Para a placa, escolhe a fonte de sinal: 'ignicao' se a placa já reportou
 * ignição ligada alguma vez, senão 'velocidade'.
 */
const detectSignalSource = async (placa) => {
    const [rows] = await db.query(
        'SELECT MAX(pos_ignicao) AS tem_ignicao FROM sigasul_positions WHERE pos_placa = ?',
        [placa]
    );
    return rows[0] && rows[0].tem_ignicao ? 'ignicao' : 'velocidade';
};

// ── Classificação ─────────────────────────────────────────────────────────────

const classify = ({ minutosTotal, minutosFora, hasLog, hasTrackerData }) => {
    if (!hasTrackerData) return 'sem_dados_rastreador';
    if (!hasLog && minutosTotal >= MIN_ACTIVITY_MIN) return 'sem_lancamento';
    if (!hasLog) return 'sem_dados_rastreador';
    if (minutosTotal === 0) return 'lancamento_sem_rastreio';
    if (minutosFora >= MIN_ACTIVITY_MIN) return 'atividade_fora_janela';
    return 'ok';
};

// ── Processamento de um (placa, data) ─────────────────────────────────────────

/**
 * Processa um dia para uma placa. Faz upsert de 1 linha por daily_work_log
 * (ou 1 linha com obra_id=NULL se não houver lançamento mas houver atividade).
 */
const processPlacaDay = async (placa, dateStr) => {
    // 1. Resolve vehicle_id — normaliza placa (vehicles sem traço, sigasul com traço)
    const [vehRows] = await db.query(
        `SELECT id FROM vehicles
         WHERE REPLACE(REPLACE(UPPER(placa),'-',''),' ','')
             = REPLACE(REPLACE(UPPER(?),'-',''),' ','')
         LIMIT 1`,
        [placa]
    );
    if (!vehRows.length) return { placa, dateStr, skipped: 'vehicle_not_found' };
    const vehicleId = vehRows[0].id;

    // 2. Fonte de sinal e posições do dia
    const fonte = await detectSignalSource(placa);
    const activityFilter = fonte === 'ignicao' ? 'pos_ignicao = 1' : 'pos_velocidade > 0';
    const [posRows] = await db.query(
        `SELECT pos_data_hora_receb FROM sigasul_positions
         WHERE pos_placa = ? AND DATE(pos_data_hora_receb) = ? AND ${activityFilter}
         ORDER BY pos_data_hora_receb`,
        [placa, dateStr]
    );
    const trackerIntervals = pointsToIntervals(posRows.map(r => toMs(r.pos_data_hora_receb)));
    const [allPosCount] = await db.query(
        `SELECT COUNT(*) AS c FROM sigasul_positions
         WHERE pos_placa = ? AND DATE(pos_data_hora_receb) = ?`,
        [placa, dateStr]
    );
    const hasTrackerData = allPosCount[0].c > 0;
    const minutosTotal = sumMinutes(trackerIntervals);

    // 3. Lançamentos do dia
    const [logs] = await db.query(
        `SELECT id, obraId, morningStart, morningEnd, afternoonStart, afternoonEnd
         FROM daily_work_logs WHERE vehicleId = ? AND date = ?`,
        [vehicleId, dateStr]
    );

    const allLogIntervals = unionIntervals(
        logs.flatMap(log => buildLogIntervals(log, dateStr))
    );
    const foraJanela = subtractWithTolerance(trackerIntervals, allLogIntervals);
    const minutosFora = sumMinutes(foraJanela);
    const minutosDentro = Math.max(0, minutosTotal - minutosFora);
    const trackerJson = JSON.stringify(serializeIntervals(trackerIntervals));

    const rowsToWrite = [];

    if (logs.length === 0) {
        const bucket = classify({
            minutosTotal,
            minutosFora: minutosTotal,
            hasLog: false,
            hasTrackerData,
        });
        rowsToWrite.push({
            vehicleId, placa, dateStr, obraId: null, dailyLogId: null,
            bucket,
            minutosTotal, minutosDentro: 0, minutosFora: minutosTotal,
            intervalosRastreador: trackerJson,
            intervalosLancados: JSON.stringify([]),
            fonte,
        });
    } else {
        for (const log of logs) {
            const logIntervals = buildLogIntervals(log, dateStr);
            const bucket = classify({
                minutosTotal,
                minutosFora,
                hasLog: true,
                hasTrackerData,
            });
            rowsToWrite.push({
                vehicleId, placa, dateStr,
                obraId: log.obraId,
                dailyLogId: log.id,
                bucket,
                minutosTotal, minutosDentro, minutosFora,
                intervalosRastreador: trackerJson,
                intervalosLancados: JSON.stringify(serializeIntervals(logIntervals)),
                fonte,
            });
        }
    }

    // 4. Upsert
    for (const r of rowsToWrite) {
        await db.query(
            `INSERT INTO billing_tracker_confronto
             (vehicle_id, placa, data, obra_id, daily_log_id, bucket,
              minutos_atividade_total, minutos_dentro_janela, minutos_fora_janela,
              intervalos_rastreador_json, intervalos_lancados_json, fonte_sinal)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
              vehicle_id = VALUES(vehicle_id),
              daily_log_id = VALUES(daily_log_id),
              bucket = VALUES(bucket),
              minutos_atividade_total = VALUES(minutos_atividade_total),
              minutos_dentro_janela = VALUES(minutos_dentro_janela),
              minutos_fora_janela = VALUES(minutos_fora_janela),
              intervalos_rastreador_json = VALUES(intervalos_rastreador_json),
              intervalos_lancados_json = VALUES(intervalos_lancados_json),
              fonte_sinal = VALUES(fonte_sinal)`,
            [
                r.vehicleId, r.placa, r.dateStr, r.obraId, r.dailyLogId, r.bucket,
                r.minutosTotal, r.minutosDentro, r.minutosFora,
                r.intervalosRastreador, r.intervalosLancados, r.fonte,
            ]
        );
    }

    return { placa, dateStr, rows: rowsToWrite.length, bucket: rowsToWrite[0]?.bucket };
};

/**
 * Processa um período arbitrário. Itera por (placa, data) que tenham posições
 * ou lançamentos no intervalo.
 */
const processRange = async (startDate, endDate, { onProgress } = {}) => {
    const [pairs] = await db.query(
        `SELECT DISTINCT pos_placa AS placa, DATE(pos_data_hora_receb) AS data
           FROM sigasul_positions
          WHERE DATE(pos_data_hora_receb) BETWEEN ? AND ?
         UNION
         SELECT DISTINCT v.placa AS placa, l.date AS data
           FROM daily_work_logs l
           JOIN vehicles v ON v.id = l.vehicleId
          WHERE l.date BETWEEN ? AND ? AND v.placa IS NOT NULL`,
        [startDate, endDate, startDate, endDate]
    );

    const results = { total: pairs.length, processed: 0, skipped: 0, byBucket: {} };
    for (let i = 0; i < pairs.length; i++) {
        const { placa, data } = pairs[i];
        const dateStr = data instanceof Date
            ? data.toISOString().slice(0, 10)
            : String(data).slice(0, 10);
        try {
            const res = await processPlacaDay(placa, dateStr);
            if (res.skipped) results.skipped++;
            else {
                results.processed++;
                results.byBucket[res.bucket] = (results.byBucket[res.bucket] || 0) + 1;
            }
        } catch (e) {
            console.error(`Erro em ${placa} ${dateStr}:`, e.message);
            results.skipped++;
        }
        if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, pairs.length);
    }
    return results;
};

/** Processa D-1 — chamado pelo cron diário após syncPositions/syncDailySummary. */
const processYesterday = async () => {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    console.log(`⏳ [Confronto] Processando ${dateStr}...`);
    await db.query('DELETE FROM billing_tracker_confronto WHERE data = ?', [dateStr]);
    const res = await processRange(dateStr, dateStr);
    console.log(`✅ [Confronto] ${dateStr}: ${res.processed} processados, ${res.skipped} ignorados.`, res.byBucket);
    return res;
};

module.exports = {
    processPlacaDay,
    processRange,
    processYesterday,
    // exportados para testes
    _internal: {
        pointsToIntervals,
        unionIntervals,
        subtractWithTolerance,
        sumMinutes,
        buildLogIntervals,
        classify,
        MERGE_GAP_MIN,
        EDGE_TOLERANCE_MIN,
        MIN_ACTIVITY_MIN,
    },
};
