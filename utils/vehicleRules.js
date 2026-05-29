// backend/utils/vehicleRules.js
//
// =============================================================================
// CÓPIA BACKEND do src/utils/vehicleRules.js (frontend)
// =============================================================================
//
// Este arquivo é uma cópia FIEL do `src/utils/vehicleRules.js` do frontend,
// porém em CommonJS puro (sem `export`) para que o Node.js consiga carregar
// sem precisar de Babel/ESM.
//
// IMPORTANTE — Sincronia entre frontend e backend:
//   O frontend continua sendo a FONTE DE VERDADE. Sempre que alterar
//   regras de veículos no `frontend/src/utils/vehicleRules.js`, replique
//   as MESMAS alterações aqui no backend.
//
//   No futuro (item 26 da análise do sistema), o ideal é extrair essas
//   regras para um pacote compartilhado (`shared/vehicleRules.js`)
//   importado por ambos os lados.
//
// =============================================================================

const vehicleGroups = {
    'Veículos Leves': ['Automóvel', 'Camionete', 'Utilitários', 'Moto'],
    'Caminhões': [
        'Bitruck', 'Caminhão Pipa', 'Caminhão Tanque', 'Caminhão Carroceria',
        'Cavalo', 'Caçamba Bitruck', 'Caçamba Toco', 'Caçamba Traçado',
        'Caçamba Truckado', 'Caminhão', 'Caçamba',
    ],
    'Caminhões de Trecho': ['Caminhão Prancha', 'Semirreboques'],
    'Máquinas Pesadas': [
        'Motoniveladora', 'Pá Carregadeira', 'Retroescavadeira', 'Rolo',
        'Trator', 'Escavadeira', 'Escavadeira + Rompedor', 'Fresadora',
        'Trator Esteira',
    ],
};

// Sub-tipos por tipo principal (select condicional no modal de veículo)
const vehicleSubTypes = {
    'Caçamba': [
        'Caminhão Caçamba Basculante 7m³', 'Caminhão Caçamba Basculante 10m³',
        'Caminhão Caçamba Basculante 12m³', 'Caminhão Caçamba Basculante 14m³',
        'Caminhão Caçamba Basculante 16m³', 'Caminhão Caçamba Basculante 20m³',
    ],
    'Escavadeira': [
        'Escavadeira Hidráulica 13T', 'Escavadeira Hidráulica 15T',
        'Escavadeira Hidráulica 23T', 'Escavadeira Hidráulica 26T',
        'Escavadeira Hidráulica 35T', 'Escavadeira Hidráulica 36T',
        'Escavadeira Hidráulica + Rompedor', 'Escavadeira Hidráulica Longo Alcance',
    ],
    'Pá Carregadeira': ['Pá Carregadeira 11T', 'Pá Carregadeira 20T'],
    'Trator Esteira':  ['Trator Esteira 21T', 'Trator Esteira 36T'],
};

const extraObraOptions = ['Administração', 'Oficina', 'Pátio', 'Rampa', 'Diversos'];
const operationalSubGroups = ['Administrativo', 'Oficina', 'Operacional', 'Supervisor'];

const equipmentTypesForHours = [
    'Caminhão', 'Escavadeira', 'Escavadeira + Rompedor', 'Rolo',
    'Retroescavadeira', 'Pá Carregadeira', 'Motoniveladora', 'Trator',
    'Trator Esteira', 'Bitruck', 'Caçamba', 'Caminhão Pipa', 'Caminhão Tanque',
];

// =============================================================================
// REGRA 1: Tipos de leitura permitidos por grupo
// =============================================================================
const getAllowedReadingTypes = (vehicleType) => {
    const group = Object.keys(vehicleGroups).find(
        key => vehicleGroups[key].includes(vehicleType)
    );

    if (group === 'Veículos Leves' || group === 'Caminhões de Trecho') {
        return ['odometro'];
    }
    return ['horimetro'];
};

// =============================================================================
// Retorna a leitura principal (Valor, Unidade e Label)
// =============================================================================
const getVehicleMainReading = (vehicle) => {
    if (!vehicle) return { value: 0, unit: '', label: 'N/A', raw: 0 };

    const allowedTypes = getAllowedReadingTypes(vehicle.tipo);
    const usesKm = allowedTypes.includes('odometro');

    if (usesKm) {
        const val = vehicle.odometro || 0;
        return { value: val, unit: 'Km', label: 'Odômetro', raw: parseFloat(val) };
    }

    const val = vehicle.horimetro || 0;
    return { value: val, unit: 'Hr', label: 'Horímetro', raw: parseFloat(val) };
};

// =============================================================================
// REGRAS 2 e 3: Validação Rigorosa de Leitura
// =============================================================================
const checkReadingConsistency = (vehicle, newValueStr, fieldType) => {
    if (!vehicle) return { status: 'ok' };

    const newValue = parseFloat(newValueStr);
    if (isNaN(newValue)) return { status: 'ok' };

    let currentValue = 0;
    let unit = '';
    let limit = 0;

    if (fieldType === 'odometro') {
        currentValue = parseFloat(vehicle.odometro || 0);
        unit = 'Km';
        limit = 1000;  // Regra: salto > 1000 Km bloqueia
    } else if (fieldType === 'horimetro') {
        currentValue = parseFloat(vehicle.horimetro || 0);
        unit = 'Hr';
        limit = 50;    // Regra: salto > 50 h bloqueia
    } else {
        return { status: 'ok' };
    }

    // Regra: Bloquear regressão (com tolerância de 0.1 para float)
    if (newValue < currentValue - 0.1) {
        return {
            status: 'bloqueio',
            message: `REGRESSÃO DETECTADA: A nova leitura (${newValue} ${unit}) não pode ser menor que a atual (${currentValue} ${unit}).`,
        };
    }

    // Regra: Bloquear salto excessivo
    const diff = newValue - currentValue;
    if (diff > limit) {
        return {
            status: 'bloqueio',
            message: `SALTO EXCESSIVO: A diferença de ${diff.toFixed(1)} ${unit} excede o limite de segurança (${limit} ${unit}).`,
        };
    }

    return { status: 'ok' };
};

// =============================================================================
// REGRA 4: Verificações de Documentos e Avisos
// =============================================================================
const checkVehicleRestrictions = (vehicle, revisions = []) => {
    const issues = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const thirtyDaysFromNow = new Date(now);
    thirtyDaysFromNow.setDate(now.getDate() + 30);

    // 1. Bloqueio Manual
    if (
        vehicle.canCirculate === false ||
        vehicle.canCirculate === 0 ||
        vehicle.canCirculate === '0'
    ) {
        issues.push({
            category: 'bloqueio',
            type: 'error',
            message: "BLOQUEIO MANUAL: Veículo marcado como 'NÃO PODE CIRCULAR'.",
        });
    }

    // 2. Revisões (Mecânica)
    const revision = revisions.find(r => r.vehicleId === vehicle.id);
    if (revision) {
        // Por Data
        if (revision.proximaRevisaoData) {
            const revDate = new Date(revision.proximaRevisaoData);
            revDate.setHours(0, 0, 0, 0);

            if (now >= revDate) {
                issues.push({
                    category: 'manutencao',
                    type: 'error',
                    message: `REVISÃO VENCIDA (Data): ${revDate.toLocaleDateString('pt-BR')}.`,
                });
            } else if (revision.avisoAntecedenciaDias > 0) {
                const dataAviso = new Date(revDate);
                dataAviso.setDate(dataAviso.getDate() - revision.avisoAntecedenciaDias);
                if (now >= dataAviso) {
                    issues.push({
                        category: 'manutencao',
                        type: 'warning',
                        message: `Revisão PRÓXIMA (Data): Vence em ${revDate.toLocaleDateString('pt-BR')}.`,
                    });
                }
            }
        }

        // Por Leitura
        const readingInfo = getVehicleMainReading(vehicle);
        const unit = readingInfo.unit;
        const currentReading = readingInfo.raw;

        let proximaLeitura = 0;
        if (unit === 'Hr') {
            proximaLeitura = parseFloat(revision.proximaRevisaoHorimetro || 0);
            if (proximaLeitura === 0 && revision.proximaRevisaoOdometro > 0) {
                proximaLeitura = parseFloat(revision.proximaRevisaoOdometro);
            }
        } else {
            proximaLeitura = parseFloat(revision.proximaRevisaoOdometro || 0);
        }

        const avisoAntecedencia = parseFloat(revision.avisoAntecedenciaKmHr || 0);

        if (proximaLeitura > 0) {
            if (currentReading >= proximaLeitura) {
                issues.push({
                    category: 'manutencao',
                    type: 'error',
                    message: `REVISÃO VENCIDA (Leitura): ${currentReading}/${proximaLeitura} ${unit}.`,
                });
            } else if (
                avisoAntecedencia > 0 &&
                currentReading >= proximaLeitura - avisoAntecedencia
            ) {
                const faltam = (proximaLeitura - currentReading).toFixed(1);
                issues.push({
                    category: 'manutencao',
                    type: 'warning',
                    message: `Revisão PRÓXIMA (Leitura): Faltam ${faltam} ${unit}.`,
                });
            }
        }
    }

    // 3. Documentos (Legal) — apenas caminhões
    const isTruck =
        vehicleGroups['Caminhões']?.includes(vehicle.tipo) ||
        vehicleGroups['Caminhões de Trecho']?.includes(vehicle.tipo);

    if (isTruck) {
        const docs = [
            { name: 'Tacógrafo', date: vehicle.validadeTacografo },
            { name: 'AET DAER', date: vehicle.validadeAET_DAER },
            { name: 'AET DNIT', date: vehicle.validadeAET_DNIT },
            { name: 'Licenciamento', date: vehicle.validadeLicenciamento },
        ];

        docs.forEach(doc => {
            if (doc.date) {
                const d = new Date(doc.date);
                const dCompare = new Date(d.getFullYear(), d.getMonth(), d.getDate());

                if (now > dCompare) {
                    issues.push({
                        category: 'documento',
                        type: 'error',
                        message: `${doc.name} VENCIDO.`,
                    });
                } else if (dCompare <= thirtyDaysFromNow) {
                    issues.push({
                        category: 'documento',
                        type: 'warning',
                        message: `${doc.name} vence em breve.`,
                    });
                }
            }
        });
    }

    return issues;
};

// =============================================================================
// EXPORTAÇÕES (CommonJS)
// =============================================================================
module.exports = {
    vehicleGroups,
    vehicleSubTypes,
    extraObraOptions,
    operationalSubGroups,
    equipmentTypesForHours,
    getAllowedReadingTypes,
    getVehicleMainReading,
    checkReadingConsistency,
    checkVehicleRestrictions,
};
