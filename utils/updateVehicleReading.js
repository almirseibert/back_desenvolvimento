const { getAllowedReadingTypes } = require('./vehicleRules');

/**
 * Atualiza odômetro ou horímetro do veículo SOMENTE se o novo valor for maior que o atual.
 * Retorna o campo atualizado ('odometro' | 'horimetro' | null).
 *
 * @param {object} connection  - Conexão MySQL (pool ou transaction)
 * @param {string} vehicleId
 * @param {string} vehicleType - vehicle.tipo (ex: 'Escavadeira', 'Automóvel')
 * @param {number|string} newReading
 * @param {string} readingType - 'odometro' | 'horimetro' | 'auto' (detecta pela regra)
 * @returns {Promise<string|null>} campo atualizado ou null
 */
async function updateVehicleReading(connection, vehicleId, vehicleType, newReading, readingType = 'auto') {
    if (!vehicleId || newReading === null || newReading === undefined || newReading === '') return null;

    const newVal = parseFloat(newReading);
    if (isNaN(newVal) || newVal <= 0) return null;

    const allowed = getAllowedReadingTypes(vehicleType);

    let field;
    if (readingType === 'auto') {
        field = allowed[0]; // 'odometro' ou 'horimetro'
    } else {
        if (!allowed.includes(readingType)) return null;
        field = readingType;
    }

    const [[current]] = await connection.execute(
        `SELECT ${field} FROM vehicles WHERE id = ?`,
        [vehicleId]
    );
    if (!current) return null;

    const currentVal = parseFloat(current[field] || 0);
    if (newVal > currentVal) {
        await connection.execute(
            `UPDATE vehicles SET ${field} = ? WHERE id = ?`,
            [newVal, vehicleId]
        );
        return field;
    }
    return null;
}

module.exports = { updateVehicleReading };
