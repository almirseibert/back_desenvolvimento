const crypto = require('crypto');

/**
 * Recalcula as médias de consumo de combustível para um veículo e faz UPSERT em
 * vehicle_fuel_averages.
 *
 * Lógica:
 *  - Busca as últimas 4 ordens concluídas do veículo (precisa de 4 para calcular 3 intervalos)
 *  - Para cada par consecutivo: (leitura_nova - leitura_anterior) / litros_abastecidos
 *  - avg_last_1 = média do par mais recente, avg_last_2 = média dos 2 pares, avg_last_3 = 3 pares
 *  - avg_by_tipo / avg_by_subtipo = média de todos os veículos com mesmo tipo/sub_tipo
 *
 * @param {object} connection  - Conexão MySQL (pool ou transaction)
 * @param {string} vehicleId
 */
async function recalcFuelAverage(connection, vehicleId) {
    if (!vehicleId) return;

    // Dados do veículo
    const [[vehicle]] = await connection.execute(
        'SELECT tipo, sub_tipo FROM vehicles WHERE id = ?',
        [vehicleId]
    );
    if (!vehicle) return;

    // Últimas 4 ordens concluídas com leitura e litros registrados
    const [orders] = await connection.execute(
        `SELECT id, odometro, horimetro, litrosAbastecidos
         FROM refuelings
         WHERE vehicleId = ?
           AND status = 'Concluída'
           AND litrosAbastecidos > 0
           AND (odometro > 0 OR horimetro > 0)
         ORDER BY data DESC
         LIMIT 4`,
        [vehicleId]
    );

    // Precisa de pelo menos 2 registros para calcular 1 intervalo
    const avgLast = [null, null, null];

    if (orders.length >= 2) {
        const intervals = [];
        for (let i = 0; i < orders.length - 1; i++) {
            const newer = orders[i];
            const older = orders[i + 1];
            const readingNewer = parseFloat(newer.odometro || newer.horimetro || 0);
            const readingOlder = parseFloat(older.odometro || older.horimetro || 0);
            const diff = readingNewer - readingOlder;
            const liters = parseFloat(newer.litrosAbastecidos || 0);
            if (diff > 0 && liters > 0) {
                intervals.push(diff / liters);
            }
        }

        // avg_last_1: só o intervalo mais recente
        if (intervals.length >= 1) avgLast[0] = round3(intervals[0]);
        // avg_last_2: média dos 2 mais recentes
        if (intervals.length >= 2) avgLast[1] = round3(avg(intervals.slice(0, 2)));
        // avg_last_3: média dos 3 mais recentes
        if (intervals.length >= 3) avgLast[2] = round3(avg(intervals.slice(0, 3)));
    }

    // Média por tipo (todos os veículos com mesmo tipo)
    const [[byTipo]] = await connection.execute(
        `SELECT AVG(avg_last_1) AS media
         FROM vehicle_fuel_averages
         WHERE vehicle_tipo = ? AND avg_last_1 IS NOT NULL`,
        [vehicle.tipo]
    );

    // Média por sub_tipo (só quando há sub_tipo definido)
    let avgBySubtipo = null;
    if (vehicle.sub_tipo) {
        const [[bySub]] = await connection.execute(
            `SELECT AVG(avg_last_1) AS media
             FROM vehicle_fuel_averages
             WHERE vehicle_sub_tipo = ? AND avg_last_1 IS NOT NULL`,
            [vehicle.sub_tipo]
        );
        if (bySub?.media) avgBySubtipo = round3(parseFloat(bySub.media));
    }

    const lastRefuelingId = orders.length > 0 ? orders[0].id : null;
    const avgByTipoVal = byTipo?.media ? round3(parseFloat(byTipo.media)) : null;

    // UPSERT
    await connection.execute(
        `INSERT INTO vehicle_fuel_averages
           (id, vehicle_id, vehicle_tipo, vehicle_sub_tipo, last_refueling_id,
            avg_last_1, avg_last_2, avg_last_3, avg_by_tipo, avg_by_subtipo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vehicle_tipo      = VALUES(vehicle_tipo),
           vehicle_sub_tipo  = VALUES(vehicle_sub_tipo),
           last_refueling_id = VALUES(last_refueling_id),
           avg_last_1        = VALUES(avg_last_1),
           avg_last_2        = VALUES(avg_last_2),
           avg_last_3        = VALUES(avg_last_3),
           avg_by_tipo       = VALUES(avg_by_tipo),
           avg_by_subtipo    = VALUES(avg_by_subtipo)`,
        [
            crypto.randomUUID(), vehicleId,
            vehicle.tipo, vehicle.sub_tipo || null, lastRefuelingId,
            avgLast[0], avgLast[1], avgLast[2],
            avgByTipoVal, avgBySubtipo
        ]
    );
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

module.exports = { recalcFuelAverage };
