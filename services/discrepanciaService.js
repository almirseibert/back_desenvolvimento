// Análise Gerencial — Discrepâncias Operacionais (Fase 1)
//
// Reaproveita os helpers de intervalo do confrontoService. A diferença
// fundamental é o modelo de dados: aqui cada (vehicle, data, obra) gera
// UMA linha contendo uma LISTA de discrepâncias detectadas (em vez de um
// bucket único). Dias sem discrepância ainda são gravados (lista vazia)
// para distinguir "OK" de "não processado".

const db = require('../database');
const {
    _internal: {
        pointsToIntervals,
        unionIntervals,
        subtractWithTolerance,
        sumMinutes,
    },
} = require('./confrontoService');

// Override local do buildLogIntervals do confrontoService.
// O original aplica "if (fim <= ini) fim += 24h" para plantão overnight,
// o que transforma intervalos nulos (ex.: afternoonStart==afternoonEnd)
// num bloco fantasma de 24h. Aqui descartamos esses casos.
const MS_PER_DAY = 24 * 60 * 60_000;
const buildLogIntervals = (log, dateStr) => {
    const intervals = [];
    const pairs = [
        [log.morningStart, log.morningEnd],
        [log.afternoonStart, log.afternoonEnd],
    ];
    for (const [start, end] of pairs) {
        if (!start || !end) continue;
        if (start === end) continue; // intervalo nulo — não é overnight
        const ini = new Date(`${dateStr}T${start}`).getTime();
        let fim = new Date(`${dateStr}T${end}`).getTime();
        if (fim < ini) fim += MS_PER_DAY; // só desloca se realmente cruza meia-noite
        if (fim - ini > 18 * 60 * 60_000) continue; // turno > 18h é improvável — descarta
        intervals.push({ inicio: ini, fim });
    }
    return intervals;
};

const LIMIAR_MIN = parseInt(process.env.ANALISE_LIMIAR_MIN || '30', 10);
const MIN_ATIVIDADE_DIA_MIN = parseInt(process.env.ANALISE_MIN_ATIVIDADE_DIA_MIN || '60', 10);

const MS_PER_MIN = 60_000;
const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

const serializeIntervals = (intervals) =>
    intervals.map(iv => ({
        inicio: new Date(iv.inicio).toISOString(),
        fim: new Date(iv.fim).toISOString(),
    }));

// Mesma lógica do confrontoService — copiada para não atrelar a mudanças futuras lá.
const detectSignalSource = async (placa) => {
    const [rows] = await db.query(
        `SELECT MAX(pos_ignicao) AS tem_ignicao FROM sigasul_positions
         WHERE REPLACE(REPLACE(UPPER(pos_placa),'-',''),' ','')
             = REPLACE(REPLACE(UPPER(?),'-',''),' ','')`,
        [placa]
    );
    return rows[0] && rows[0].tem_ignicao ? 'ignicao' : 'velocidade';
};

// ── Detectores de discrepância (Fase 1) ──────────────────────────────────────

// Agrupa intervalos do mesmo tipo numa única discrepância — magnitude é a soma,
// intervalos_envolvidos preserva a granularidade. Filtra ruído individual
// (intervalo < LIMIAR_MIN) antes de somar, pra não inflar com micro-gaps.
const consolidar = (intervals, tipo) => {
    const significativos = intervals.filter(
        iv => (iv.fim - iv.inicio) / MS_PER_MIN >= LIMIAR_MIN
    );
    if (!significativos.length) return [];
    const magnitude_min = Math.round(
        significativos.reduce((s, iv) => s + (iv.fim - iv.inicio), 0) / MS_PER_MIN
    );
    return [{
        tipo,
        magnitude_min,
        intervalos_envolvidos: serializeIntervals(significativos),
    }];
};

const detectMaquinaAlemDoFaturado = (trackerIntervals, logIntervals) =>
    consolidar(subtractWithTolerance(trackerIntervals, logIntervals), 'maquina_alem_do_faturado');

const detectFaturadoAlemDaMaquina = (trackerIntervals, logIntervals) =>
    consolidar(subtractWithTolerance(logIntervals, trackerIntervals), 'faturado_alem_da_maquina');

const detectSemLancamentoComAtividade = (trackerIntervals, hasLog) => {
    if (hasLog) return [];
    const total = sumMinutes(trackerIntervals);
    if (total < MIN_ATIVIDADE_DIA_MIN) return [];
    return [{
        tipo: 'sem_lancamento_com_atividade',
        magnitude_min: total,
        intervalos_envolvidos: serializeIntervals(trackerIntervals),
    }];
};

// ── Processamento de um (placa, data) ────────────────────────────────────────

const processPlacaDay = async (placa, dateStr) => {
    const [vehRows] = await db.query(
        `SELECT id FROM vehicles
         WHERE REPLACE(REPLACE(UPPER(placa),'-',''),' ','')
             = REPLACE(REPLACE(UPPER(?),'-',''),' ','')
         LIMIT 1`,
        [placa]
    );
    if (!vehRows.length) return { placa, dateStr, skipped: 'vehicle_not_found' };
    const vehicleId = vehRows[0].id;

    const fonte = await detectSignalSource(placa);
    const activityFilter = fonte === 'ignicao' ? 'pos_ignicao = 1' : 'pos_velocidade > 0';
    // Normaliza a placa na comparação para suportar formatos com/sem traço ou espaço,
    // evitando que veículos com placa "ABC-1234" em vehicles e "ABC1234" em sigasul
    // sejam tratados como entidades distintas no processRange (bug: segunda chamada
    // sobrescrevia rastreador_intervalos_json com array vazio via ON DUPLICATE KEY UPDATE).
    const placaNorm = `REPLACE(REPLACE(UPPER(pos_placa),'-',''),' ','') = REPLACE(REPLACE(UPPER(?),'-',''),' ','')`;
    const [posRows] = await db.query(
        `SELECT pos_data_hora_receb FROM sigasul_positions
         WHERE ${placaNorm} AND DATE(pos_data_hora_receb) = ? AND ${activityFilter}
         ORDER BY pos_data_hora_receb`,
        [placa, dateStr]
    );
    const trackerIntervals = pointsToIntervals(posRows.map(r => toMs(r.pos_data_hora_receb)));
    const [allPosCount] = await db.query(
        `SELECT COUNT(*) AS c FROM sigasul_positions
         WHERE ${placaNorm} AND DATE(pos_data_hora_receb) = ?`,
        [placa, dateStr]
    );
    const hasTrackerData = allPosCount[0].c > 0;

    const [logs] = await db.query(
        `SELECT id, obraId, morningStart, morningEnd, afternoonStart, afternoonEnd
         FROM daily_work_logs WHERE vehicleId = ? AND date = ?`,
        [vehicleId, dateStr]
    );

    const fontesDisponiveis = {
        faturado: logs.length > 0,
        rastreador: hasTrackerData,
        ponto: false, // Fase 2 — preencher quando integração do ponto entrar
    };

    const rowsToWrite = [];

    if (logs.length === 0) {
        // Sem lançamento: tenta resgatar obra+operador via histórico de alocação.
        // Cobre o caso em que o veículo estava oficialmente alocado a uma obra
        // mas o operador não fechou o dia em daily_work_logs.
        const [hist] = await db.query(
            `SELECT obraId, employeeId
               FROM obras_historico_veiculos
              WHERE veiculoId = ?
                AND DATE(dataEntrada) <= ?
                AND (dataSaida IS NULL OR DATE(dataSaida) >= ?)
              ORDER BY dataEntrada DESC
              LIMIT 1`,
            [vehicleId, dateStr, dateStr]
        );
        const alloc = hist[0] || {};

        const discrepancias = detectSemLancamentoComAtividade(trackerIntervals, false);
        rowsToWrite.push({
            vehicleId,
            dateStr,
            obraId: alloc.obraId || null,
            employeeId: alloc.employeeId || null,
            discrepancias,
            faturadoIntervalos: [],
            rastreadorIntervalos: serializeIntervals(trackerIntervals),
            pontoIntervalos: null,
            fontesDisponiveis,
            fonte,
        });
    } else {
        for (const log of logs) {
            const logIntervals = buildLogIntervals(log, dateStr);

            const discrepancias = [
                ...detectMaquinaAlemDoFaturado(trackerIntervals, logIntervals),
                ...detectFaturadoAlemDaMaquina(trackerIntervals, logIntervals),
            ];
            // Quando há mais de um log no dia, o "sem lançamento" não se aplica.

            rowsToWrite.push({
                vehicleId,
                dateStr,
                obraId: log.obraId,
                employeeId: null,
                discrepancias,
                faturadoIntervalos: serializeIntervals(unionIntervals(logIntervals)),
                rastreadorIntervalos: serializeIntervals(trackerIntervals),
                pontoIntervalos: null,
                fontesDisponiveis,
                fonte,
            });
        }
    }

    for (const r of rowsToWrite) {
        const maiorMag = r.discrepancias.reduce((m, d) => Math.max(m, d.magnitude_min), 0);
        await db.query(
            `INSERT INTO analise_dia_maquina
             (obra_id, data, vehicle_id, employee_id,
              discrepancias_json, maior_magnitude_min, fontes_disponiveis_json,
              faturado_intervalos_json, rastreador_intervalos_json, ponto_intervalos_json,
              fonte_sinal)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
              vehicle_id = VALUES(vehicle_id),
              employee_id = VALUES(employee_id),
              discrepancias_json = VALUES(discrepancias_json),
              maior_magnitude_min = VALUES(maior_magnitude_min),
              fontes_disponiveis_json = VALUES(fontes_disponiveis_json),
              faturado_intervalos_json = VALUES(faturado_intervalos_json),
              rastreador_intervalos_json = VALUES(rastreador_intervalos_json),
              ponto_intervalos_json = VALUES(ponto_intervalos_json),
              fonte_sinal = VALUES(fonte_sinal),
              -- Preserva justificativa ao reprocessar
              justificado_em = justificado_em,
              justificado_por = justificado_por,
              justificativa = justificativa`,
            [
                r.obraId, r.dateStr, r.vehicleId, r.employeeId,
                JSON.stringify(r.discrepancias), maiorMag, JSON.stringify(r.fontesDisponiveis),
                JSON.stringify(r.faturadoIntervalos),
                JSON.stringify(r.rastreadorIntervalos),
                r.pontoIntervalos === null ? null : JSON.stringify(r.pontoIntervalos),
                r.fonte,
            ]
        );
    }

    const totalDiscrepancias = rowsToWrite.reduce((s, r) => s + r.discrepancias.length, 0);
    return { placa, dateStr, rows: rowsToWrite.length, discrepancias: totalDiscrepancias };
};

const processRange = async (startDate, endDate, { onProgress } = {}) => {
    // Agrupa por (vehicle_id, data) para evitar pares duplicados quando o formato
    // da placa difere entre sigasul_positions (ex: "ABC1234") e vehicles (ex: "ABC-1234").
    // Usa vehicles.placa como placa canônica para que processPlacaDay possa resolver
    // o vehicleId corretamente; a query interna do sigasul usa comparação normalizada.
    const [pairs] = await db.query(
        `SELECT v.placa, dates.data
           FROM (
             SELECT DISTINCT
               (SELECT id FROM vehicles
                 WHERE REPLACE(REPLACE(UPPER(placa),'-',''),' ','')
                     = REPLACE(REPLACE(UPPER(sp.pos_placa),'-',''),' ','')
                 LIMIT 1) AS vehicle_id,
               DATE(sp.pos_data_hora_receb) AS data
               FROM sigasul_positions sp
              WHERE DATE(sp.pos_data_hora_receb) BETWEEN ? AND ?
             UNION
             SELECT DISTINCT vehicleId AS vehicle_id, date AS data
               FROM daily_work_logs
              WHERE date BETWEEN ? AND ?
           ) dates
           JOIN vehicles v ON v.id = dates.vehicle_id
          WHERE dates.vehicle_id IS NOT NULL AND v.placa IS NOT NULL`,
        [startDate, endDate, startDate, endDate]
    );

    const results = { total: pairs.length, processed: 0, skipped: 0, discrepancias: 0 };
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
                results.discrepancias += res.discrepancias || 0;
            }
        } catch (e) {
            console.error(`[Discrepancia] Erro em ${placa} ${dateStr}:`, e.message);
            results.skipped++;
        }
        if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, pairs.length);
    }
    return results;
};

const processYesterday = async () => {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    console.log(`⏳ [Discrepancia] Processando ${dateStr}...`);
    await db.query('DELETE FROM analise_dia_maquina WHERE data = ? AND justificado_em IS NULL', [dateStr]);
    const res = await processRange(dateStr, dateStr);
    console.log(`✅ [Discrepancia] ${dateStr}: ${res.processed} linhas, ${res.discrepancias} discrepâncias, ${res.skipped} ignoradas.`);
    return res;
};

module.exports = {
    processPlacaDay,
    processRange,
    processYesterday,
    _internal: {
        detectMaquinaAlemDoFaturado,
        detectFaturadoAlemDaMaquina,
        detectSemLancamentoComAtividade,
        LIMIAR_MIN,
        MIN_ATIVIDADE_DIA_MIN,
    },
};
