const https = require('https');
const db = require('../database');

const SIGASUL_BASE = 'https://gestao.sigasul.com.br';
const agent = new https.Agent({ rejectUnauthorized: false }); // SigaSul usa cert auto-assinado

const sigasulFetch = async (path) => {
    const token = process.env.SIGASUL_TOKEN;
    if (!token) throw new Error('SIGASUL_TOKEN não configurado no servidor.');

    const res = await fetch(`${SIGASUL_BASE}${path}`, {
        headers: {
            'x-auth-token': token,
            'Cache-Control': 'no-cache',
        },
        agent,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SigaSul retornou ${res.status}: ${text}`);
    }

    return res.json();
};

// Retorna a data de hoje no formato YYYY-MM-DD (fuso GMT-3)
const todayGmt3 = () => {
    const d = new Date(Date.now() - 3 * 3600000);
    return d.toISOString().slice(0, 10);
};

// Retorna true se a data (YYYY-MM-DD) for hoje ou futura (dados não sincronizados ainda)
const isNotSynced = (dateStr) => dateStr >= todayGmt3();

// ── Helpers para dividir um range em parte histórica (banco) e hoje (API) ─────

const splitRange = (from, to) => {
    const today = todayGmt3();
    const fromDate = from.slice(0, 10);
    const toDate   = to.slice(0, 10);

    const dbFrom  = fromDate < today ? from : null;
    const dbTo    = toDate   < today ? to   : `${today} 00:00:00`;
    const apiFrom = fromDate < today ? `${today} 00:00:00` : from;
    const apiTo   = toDate  >= today ? to   : null;

    return {
        db:  (dbFrom && dbTo && dbFrom < dbTo) ? { from: dbFrom, to: dbTo } : null,
        api: apiTo ? { from: apiFrom, to: apiTo } : null,
    };
};

// ── Cache de posições ao vivo ──────────────────────────────────────────────────
// Regras:
//   - Requisição normal: retorna cache se tiver menos de 5 min; caso contrário busca API
//   - ?force=true: ignora TTL e força busca da API (botão "Atualizar" no painel)
//   - Background: atualiza automaticamente a cada 1h independente de requisições
//   - Guard: se já houver uma busca em andamento, espera ela terminar (sem chamadas duplicadas)

const POSITIONS_CACHE_TTL_MS  = 5  * 60 * 1000; // 5 minutos — janela de cache entre aberturas
const POSITIONS_BG_INTERVAL_MS = 60 * 60 * 1000; // 1 hora   — refresh automático em background

let positionsCache = { data: null, fetchedAt: 0 };
let positionsFetchPromise = null; // guard de concorrência

const fetchAndCachePositions = async () => {
    if (positionsFetchPromise) return positionsFetchPromise;
    positionsFetchPromise = sigasulFetch('/api/positions/all')
        .then(data => {
            positionsCache = { data, fetchedAt: Date.now() };
            console.log(`✅ [SigaSul] Cache de posições atualizado (${Array.isArray(data) ? data.length : '?'} veículos)`);
            return data;
        })
        .finally(() => { positionsFetchPromise = null; });
    return positionsFetchPromise;
};

// Refresh automático em background a cada 1 hora
setInterval(() => {
    fetchAndCachePositions().catch(e =>
        console.error('❌ [SigaSul] Falha no refresh automático de posições:', e.message)
    );
}, POSITIONS_BG_INTERVAL_MS);

// ── GET /api/sigasul/positions ─────────────────────────────────────────────────
const getPositions = async (req, res) => {
    try {
        const force     = req.query.force === 'true';
        const cacheAge  = Date.now() - positionsCache.fetchedAt;
        const cacheOk   = positionsCache.data !== null && cacheAge < POSITIONS_CACHE_TTL_MS;

        if (!force && cacheOk) {
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('X-Cache-Age', Math.floor(cacheAge / 1000) + 's');
            return res.json(positionsCache.data);
        }

        const data = await fetchAndCachePositions();
        res.setHeader('X-Cache', 'MISS');
        res.json(data);
    } catch (e) {
        console.error('❌ SigaSul getPositions:', e.message);
        // Se tiver cache antigo, devolve ele em vez de erro
        if (positionsCache.data) return res.json(positionsCache.data);
        res.status(502).json({ message: e.message });
    }
};

// ── GET /api/sigasul/positions/period?from=...&to=... ─────────────────────────
const getPositionsByPeriod = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });

    try {
        const { db: dbRange, api: apiRange } = splitRange(from, to);
        let result = [];

        if (dbRange) {
            const [rows] = await db.query(
                `SELECT pos_id_ref, pos_data_hora_receb, pos_placa, pos_latitude, pos_longitude,
                        pos_ignicao, pos_velocidade, pos_odometro_calc, pos_equip_id
                 FROM sigasul_positions
                 WHERE pos_data_hora_receb BETWEEN ? AND ?
                 ORDER BY pos_data_hora_receb`,
                [dbRange.from, dbRange.to]
            );
            result = result.concat(rows);
        }

        if (apiRange) {
            const data = await sigasulFetch(
                `/api/v1/positions/data/${encodeURIComponent(apiRange.from)}/${encodeURIComponent(apiRange.to)}`
            );
            if (Array.isArray(data)) result = result.concat(data);
        }

        res.json(result);
    } catch (e) {
        console.error('❌ SigaSul getPositionsByPeriod:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// ── GET /api/sigasul/positions/vehicle/:plate?from=...&to=... ─────────────────
const getPositionsByPlate = async (req, res) => {
    const { plate } = req.params;
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });

    try {
        const { db: dbRange, api: apiRange } = splitRange(from, to);
        let result = [];

        if (dbRange) {
            const [rows] = await db.query(
                `SELECT pos_id_ref, pos_data_hora_receb, pos_placa, pos_latitude, pos_longitude,
                        pos_ignicao, pos_velocidade, pos_odometro_calc, pos_equip_id
                 FROM sigasul_positions
                 WHERE pos_placa = ? AND pos_data_hora_receb BETWEEN ? AND ?
                 ORDER BY pos_data_hora_receb`,
                [plate, dbRange.from, dbRange.to]
            );
            result = result.concat(rows);
        }

        if (apiRange) {
            const data = await sigasulFetch(
                `/api/positions/veiculo/placa/${encodeURIComponent(plate)}/${encodeURIComponent(apiRange.from)}/${encodeURIComponent(apiRange.to)}`
            );
            if (Array.isArray(data)) result = result.concat(data);
        }

        res.json(result);
    } catch (e) {
        console.error('❌ SigaSul getPositionsByPlate:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// ── GET /api/sigasul/journeys ─────────────────────────────────────────────────
// Jornadas recentes: lê do banco (sincronizado a cada 1 min pelo cron)
const getJourneys = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT j.id_jornada, j.id_motorista, j.nome_motorista, j.cartao_motorista,
                    j.id_cliente, j.nome_cliente, j.data_inicial, j.data_final, j.duracao_segundos,
                    JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'id_evento', e.id_evento,
                            'id_evento_controle', e.id_evento_controle,
                            'id_tipo_evento', e.id_tipo_evento,
                            'nome_tipo_evento', e.nome_tipo_evento,
                            'placa', e.placa,
                            'latitude', e.latitude,
                            'longitude', e.longitude,
                            'data_inicio', e.data_inicio,
                            'data_fim', e.data_fim
                        )
                    ) AS eventos
             FROM sigasul_journeys j
             LEFT JOIN sigasul_journey_events e ON e.id_jornada = j.id_jornada
             WHERE j.data_inicial >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                OR j.data_final IS NULL
             GROUP BY j.id_jornada
             ORDER BY j.data_inicial DESC`
        );
        res.json(rows);
    } catch (e) {
        console.error('❌ SigaSul getJourneys (DB):', e.message);
        // Fallback para a API se o banco falhar
        try {
            const data = await sigasulFetch('/api/jornadas/events/control');
            res.json(data);
        } catch (e2) {
            console.error('❌ SigaSul getJourneys (API fallback):', e2.message);
            res.status(502).json({ message: e2.message });
        }
    }
};

// ── GET /api/sigasul/journeys/simplified?from=...&to=... ─────────────────────
const getJourneysSimplified = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });

    try {
        const { db: dbRange, api: apiRange } = splitRange(from, to);
        let result = [];

        if (dbRange) {
            const [rows] = await db.query(
                `SELECT placa, data, total_horas_ligado, total_km, num_eventos
                 FROM sigasul_daily_summary
                 WHERE data BETWEEN ? AND ?
                 ORDER BY data, placa`,
                [dbRange.from.slice(0, 10), dbRange.to.slice(0, 10)]
            );
            result = result.concat(rows);
        }

        if (apiRange) {
            const data = await sigasulFetch(
                `/api/jornadas/simplificada/${encodeURIComponent(apiRange.from)}/${encodeURIComponent(apiRange.to)}`
            );
            if (Array.isArray(data)) result = result.concat(data);
        }

        res.json(result);
    } catch (e) {
        console.error('❌ SigaSul getJourneysSimplified:', e.message);
        res.status(502).json({ message: e.message });
    }
};

// ── GET /api/sigasul/journeys/aggregate?from=...&to=... ──────────────────────
// Agrega tempoLigado + distancia por placa. Para histórico usa banco (muito mais rápido).
// Para hoje chama a API e agrega na memória.
const getJourneysAggregate = async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Parâmetros from e to são obrigatórios.' });

    const start = new Date(from.replace(' ', 'T'));
    const end   = new Date(to.replace(' ', 'T'));
    if (isNaN(start) || isNaN(end) || end <= start) {
        return res.status(400).json({ message: 'Período inválido.' });
    }

    const hmsToMs = (hms) => {
        if (!hms) return 0;
        const [h, m, s] = hms.split(':').map(Number);
        return ((h * 3600) + (m * 60) + (s || 0)) * 1000;
    };

    try {
        const { db: dbRange, api: apiRange } = splitRange(from, to);
        const totals = {}; // { [placa]: { placa, totalMs, totalKm, eventos } }

        // Histórico: consulta agregada no banco (muito rápida)
        if (dbRange) {
            const [rows] = await db.query(
                `SELECT placa,
                        SUM(total_horas_ligado) AS totalHoras,
                        SUM(total_km)           AS totalKm,
                        SUM(num_eventos)        AS eventos
                 FROM sigasul_daily_summary
                 WHERE data BETWEEN ? AND ?
                 GROUP BY placa`,
                [dbRange.from.slice(0, 10), dbRange.to.slice(0, 10)]
            );
            for (const row of rows) {
                if (!totals[row.placa]) totals[row.placa] = { placa: row.placa, totalMs: 0, totalKm: 0, eventos: 0 };
                totals[row.placa].totalMs  += Number(row.totalHoras) * 3600000;
                totals[row.placa].totalKm  += Number(row.totalKm);
                totals[row.placa].eventos  += Number(row.eventos);
            }
        }

        // Hoje: chama a API em janelas de 24h (mesma lógica anterior)
        if (apiRange) {
            const pad = (n) => String(n).padStart(2, '0');
            const fmt = (d) =>
                `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
                `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

            const apiStart = new Date(apiRange.from.replace(' ', 'T'));
            const apiEnd   = new Date(apiRange.to.replace(' ', 'T'));

            const windows = [];
            let cursor = new Date(apiStart);
            while (cursor < apiEnd) {
                const windowEnd = new Date(Math.min(cursor.getTime() + 24 * 3600 * 1000, apiEnd.getTime()));
                windows.push({ from: fmt(cursor), to: fmt(windowEnd) });
                cursor = windowEnd;
            }

            for (const w of windows) {
                let data;
                try {
                    data = await sigasulFetch(
                        `/api/jornadas/simplificada/${encodeURIComponent(w.from)}/${encodeURIComponent(w.to)}`
                    );
                } catch (e) {
                    console.warn(`⚠️ SigaSul aggregate janela ${w.from}→${w.to}: ${e.message}`);
                    continue;
                }

                if (!Array.isArray(data)) continue;
                for (const vehicle of data) {
                    const placa = vehicle.placa;
                    if (!placa) continue;
                    if (!totals[placa]) totals[placa] = { placa, totalMs: 0, totalKm: 0, eventos: 0 };
                    for (const ev of (vehicle.eventos || [])) {
                        totals[placa].totalMs  += hmsToMs(ev.tempoLigado);
                        totals[placa].totalKm  += Number(ev.distancia) || 0;
                        totals[placa].eventos  += 1;
                    }
                }
            }
        }

        const result = Object.values(totals).map(t => ({
            placa:            t.placa,
            totalHorasLigado: t.totalMs / 3600000,
            totalKm:          t.totalKm,
            eventos:          t.eventos,
        }));

        res.json(result);
    } catch (e) {
        console.error('❌ SigaSul getJourneysAggregate:', e.message);
        res.status(502).json({ message: e.message });
    }
};

module.exports = { getPositions, getPositionsByPeriod, getPositionsByPlate, getJourneys, getJourneysSimplified, getJourneysAggregate };
