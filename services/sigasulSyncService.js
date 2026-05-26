const https = require('https');
const db = require('../database');

const SIGASUL_BASE = 'https://gestao.sigasul.com.br';
const agent = new https.Agent({ rejectUnauthorized: false });

const sigasulFetch = async (path) => {
    const token = process.env.SIGASUL_TOKEN;
    if (!token) throw new Error('SIGASUL_TOKEN não configurado.');
    const res = await fetch(`${SIGASUL_BASE}${path}`, {
        headers: { 'x-auth-token': token, 'Cache-Control': 'no-cache' },
        agent,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SigaSul ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
};

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const hmsToDecimal = (hms) => {
    if (!hms) return 0;
    const [h, m, s] = hms.split(':').map(Number);
    return h + m / 60 + (s || 0) / 3600;
};

// ── Estado de sincronização ────────────────────────────────────────────────────

const getSyncState = async () => {
    const [rows] = await db.query('SELECT * FROM sigasul_sync_state WHERE id = 1');
    return rows[0] || { last_evento_controle_id: 0, last_positions_sync_date: null, last_summary_sync_date: null };
};

const updateSyncState = async (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE sigasul_sync_state SET ${sets} WHERE id = 1`, Object.values(fields));
};

// ── 1. Sync de Jornadas (incremental a cada 1 min) ────────────────────────────

let journeySyncRunning = false;

const syncJourneyEvents = async () => {
    if (journeySyncRunning) return;
    journeySyncRunning = true;
    try {
        const state = await getSyncState();
        const lastId = state.last_evento_controle_id || 0;

        const data = await sigasulFetch(`/api/v2/jornadas/events/control/${lastId}`);
        if (!Array.isArray(data) || data.length === 0) return;

        let maxControleId = lastId;

        for (const jornada of data) {
            // Upsert jornada
            const duracao = jornada.data_inicial && jornada.data_final
                ? Math.round((new Date(jornada.data_final) - new Date(jornada.data_inicial)) / 1000)
                : null;

            await db.query(`
                INSERT IGNORE INTO sigasul_journeys
                    (id_jornada, id_motorista, nome_motorista, cartao_motorista, id_cliente, nome_cliente, data_inicial, data_final, duracao_segundos)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                jornada.id_jornada,
                jornada.id_motorista || null,
                jornada.nome_motorista || null,
                jornada.cartao_motorista || null,
                jornada.id_cliente || null,
                jornada.nome_cliente || null,
                jornada.data_inicial || null,
                jornada.data_final || null,
                duracao,
            ]);

            for (const ev of (jornada.eventos || [])) {
                await db.query(`
                    INSERT IGNORE INTO sigasul_journey_events
                        (id_evento, id_evento_controle, id_jornada, id_tipo_evento, nome_tipo_evento, placa, latitude, longitude, data_inicio, data_fim)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    ev.id_evento,
                    ev.id_evento_controle,
                    jornada.id_jornada,
                    ev.id_tipo_evento || null,
                    ev.nome_tipo_evento || null,
                    ev.placa || null,
                    ev.latitude ? parseFloat(ev.latitude) : null,
                    ev.longitude ? parseFloat(ev.longitude) : null,
                    ev.data_inicio || null,
                    ev.data_fim || null,
                ]);

                if (ev.id_evento_controle > maxControleId) maxControleId = ev.id_evento_controle;
            }
        }

        if (maxControleId > lastId) {
            await updateSyncState({ last_evento_controle_id: maxControleId });
            console.log(`✅ [SigaSul] Jornadas sincronizadas. Novo cursor: ${maxControleId}`);
        }
    } catch (e) {
        console.error('❌ [SigaSul] Erro sync jornadas:', e.message);
    } finally {
        journeySyncRunning = false;
    }
};

// ── 2. Sync de Posições históricas (diário às 02:00) ──────────────────────────

let positionSyncRunning = false;

const syncPositions = async () => {
    if (positionSyncRunning) return;
    positionSyncRunning = true;
    try {
        const state = await getSyncState();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;

        if (state.last_positions_sync_date === yesterdayStr) {
            console.log(`ℹ️ [SigaSul] Posições de ${yesterdayStr} já sincronizadas.`);
            return;
        }

        console.log(`⏳ [SigaSul] Iniciando sync de posições para ${yesterdayStr}...`);

        const from = `${yesterdayStr} 00:00:00`;
        const to   = `${yesterdayStr} 23:59:59`;
        const data = await sigasulFetch(
            `/api/v1/positions/data/${encodeURIComponent(from)}/${encodeURIComponent(to)}`
        );

        if (!Array.isArray(data) || data.length === 0) {
            await updateSyncState({ last_positions_sync_date: yesterdayStr });
            console.log(`ℹ️ [SigaSul] Nenhuma posição retornada para ${yesterdayStr}.`);
            return;
        }

        // Bulk insert em lotes de 500
        const BATCH = 500;
        let inserted = 0;
        for (let i = 0; i < data.length; i += BATCH) {
            const batch = data.slice(i, i + BATCH);
            const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
            const values = batch.flatMap(p => [
                p.pos_id_ref,
                p.pos_data_hora_receb || null,
                p.pos_placa || null,
                p.pos_latitude != null ? p.pos_latitude : null,
                p.pos_longitude != null ? p.pos_longitude : null,
                p.pos_ignicao != null ? (p.pos_ignicao ? 1 : 0) : null,
                p.pos_velocidade != null ? p.pos_velocidade : null,
                p.pos_odometro_calc != null ? p.pos_odometro_calc : null,
                p.pos_equip_id || null,
            ]);
            await db.query(`
                INSERT IGNORE INTO sigasul_positions
                    (pos_id_ref, pos_data_hora_receb, pos_placa, pos_latitude, pos_longitude, pos_ignicao, pos_velocidade, pos_odometro_calc, pos_equip_id)
                VALUES ${placeholders}
            `, values);
            inserted += batch.length;
        }

        // Limpeza de registros com mais de 90 dias
        const [del] = await db.query(
            `DELETE FROM sigasul_positions WHERE pos_data_hora_receb < DATE_SUB(NOW(), INTERVAL 90 DAY)`
        );

        await updateSyncState({ last_positions_sync_date: yesterdayStr });
        console.log(`✅ [SigaSul] Posições: ${inserted} registros inseridos, ${del.affectedRows} expirados removidos.`);
    } catch (e) {
        console.error('❌ [SigaSul] Erro sync posições:', e.message);
    } finally {
        positionSyncRunning = false;
    }
};

// ── 3. Sync de Resumo Diário (diário às 03:00) ────────────────────────────────

let summarySyncRunning = false;

const syncDailySummary = async () => {
    if (summarySyncRunning) return;
    summarySyncRunning = true;
    try {
        const state = await getSyncState();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;

        if (state.last_summary_sync_date === yesterdayStr) {
            console.log(`ℹ️ [SigaSul] Resumo de ${yesterdayStr} já sincronizado.`);
            return;
        }

        console.log(`⏳ [SigaSul] Iniciando sync de resumo diário para ${yesterdayStr}...`);

        const from = `${yesterdayStr} 00:00:00`;
        const to   = `${yesterdayStr} 23:59:59`;
        const data = await sigasulFetch(
            `/api/jornadas/simplificada/${encodeURIComponent(from)}/${encodeURIComponent(to)}`
        );

        if (!Array.isArray(data) || data.length === 0) {
            await updateSyncState({ last_summary_sync_date: yesterdayStr });
            return;
        }

        // Agrega por placa
        const byPlaca = {};
        for (const vehicle of data) {
            const placa = vehicle.placa;
            if (!placa) continue;
            if (!byPlaca[placa]) byPlaca[placa] = { totalH: 0, totalKm: 0, eventos: 0 };
            for (const ev of (vehicle.eventos || [])) {
                byPlaca[placa].totalH  += hmsToDecimal(ev.tempoLigado);
                byPlaca[placa].totalKm += Number(ev.distancia) || 0;
                byPlaca[placa].eventos += 1;
            }
        }

        for (const [placa, totals] of Object.entries(byPlaca)) {
            await db.query(`
                INSERT INTO sigasul_daily_summary (placa, data, total_horas_ligado, total_km, num_eventos)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    total_horas_ligado = VALUES(total_horas_ligado),
                    total_km = VALUES(total_km),
                    num_eventos = VALUES(num_eventos)
            `, [placa, yesterdayStr, totals.totalH, totals.totalKm, totals.eventos]);
        }

        await updateSyncState({ last_summary_sync_date: yesterdayStr });
        console.log(`✅ [SigaSul] Resumo diário: ${Object.keys(byPlaca).length} placas sincronizadas para ${yesterdayStr}.`);
    } catch (e) {
        console.error('❌ [SigaSul] Erro sync resumo diário:', e.message);
    } finally {
        summarySyncRunning = false;
    }
};

module.exports = { syncJourneyEvents, syncPositions, syncDailySummary };
