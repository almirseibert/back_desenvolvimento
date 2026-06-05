// utils/ensureComboioPartner.js
// Mantém sincronizada uma linha em `partners` (tipo_parceiro='comboio')
// para cada veículo marcado como comboio. Permite que distribuições
// (saídas) referenciem o comboio como "posto" e apareçam nas listas/
// histórico onde o sistema espera um partner válido.

const COMBOIO_PARTNER_PREFIX = 'comboio-';

const buildComboioPartnerId = (vehicleId) => `${COMBOIO_PARTNER_PREFIX}${vehicleId}`;

// Formato: "Comboio-RE546(F-4000 COMBOIO S. GABRIEL)"
// — usa o modelo (descritivo) entre parênteses; cai pra placa se modelo faltar.
const buildComboioPartnerName = (vehicle) => {
    const reg = vehicle?.registroInterno || '';
    const detail = (vehicle?.modelo || vehicle?.placa || '').trim();
    const head = reg ? `Comboio-${reg}` : 'Comboio';
    return detail ? `${head}(${detail})` : head;
};

// Cria ou atualiza o partner "comboio" referente ao veículo.
// Aceita um db client (pool ou connection) — quando dentro de uma transação,
// passe a `connection` para participar do mesmo commit/rollback.
const ensureComboioPartner = async (dbClient, vehicleId, { activate = true } = {}) => {
    if (!vehicleId) return null;

    const [vRows] = await dbClient.query(
        'SELECT id, placa, registroInterno, modelo, status, isComboioVehicle FROM vehicles WHERE id = ?',
        [vehicleId]
    );
    if (vRows.length === 0) return null;
    const vehicle = vRows[0];

    const partnerId = buildComboioPartnerId(vehicleId);
    const razaoSocial = buildComboioPartnerName(vehicle);
    const status_operacional = activate && vehicle.isComboioVehicle ? 'ATIVO' : 'BLOQUEADO';

    // UPSERT — usa INSERT ... ON DUPLICATE KEY UPDATE pra garantir idempotência
    await dbClient.query(
        `INSERT INTO partners (id, razaoSocial, tipo_parceiro, status_operacional)
         VALUES (?, ?, 'comboio', ?)
         ON DUPLICATE KEY UPDATE
            razaoSocial = VALUES(razaoSocial),
            tipo_parceiro = 'comboio',
            status_operacional = VALUES(status_operacional)`,
        [partnerId, razaoSocial, status_operacional]
    );

    return { id: partnerId, razaoSocial, tipo_parceiro: 'comboio', status_operacional };
};

// Marca o partner do comboio como BLOQUEADO (não deleta, para preservar
// referências históricas em refuelings/comboio_transactions).
const deactivateComboioPartner = async (dbClient, vehicleId) => {
    if (!vehicleId) return;
    const partnerId = buildComboioPartnerId(vehicleId);
    await dbClient.query(
        `UPDATE partners SET status_operacional = 'BLOQUEADO' WHERE id = ?`,
        [partnerId]
    );
};

// Sincroniza todos os comboios já existentes — usado uma vez no boot do server
// para popular partners ausentes. Idempotente: rodar várias vezes é seguro.
const syncAllComboioPartners = async (dbClient) => {
    const [vehicles] = await dbClient.query(
        'SELECT id FROM vehicles WHERE isComboioVehicle = 1'
    );
    let created = 0;
    for (const v of vehicles) {
        const result = await ensureComboioPartner(dbClient, v.id, { activate: true });
        if (result) created++;
    }
    return { synced: created, total: vehicles.length };
};

module.exports = {
    buildComboioPartnerId,
    buildComboioPartnerName,
    ensureComboioPartner,
    deactivateComboioPartner,
    syncAllComboioPartners,
};
