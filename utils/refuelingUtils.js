// utils/refuelingUtils.js

// Tabela de Normalização de Combustíveis
const FUEL_TYPES_MAP = {
    'DIESEL S10': 'dieselS10',
    'DIESEL S500': 'dieselS500',
    'GASOLINA COMUM': 'gasolinaComum',
    'GASOLINA ADITIVADA': 'gasolinaAditivada',
    'ETANOL': 'etanol',
    'ARLA 32': 'arla32'
};

/**
 * Converte o nome de exibição (ex: "DIESEL S10") para o padrão do banco (ex: "dieselS10")
 */
const normalizeFuelType = (val) => {
    if (!val) return null;
    const v = val.toString().trim().toUpperCase();
    return FUEL_TYPES_MAP[v] || val;
};

/**
 * Valida a leitura de Odômetro ou Horímetro
 * Retorna string de erro ou null se estiver OK
 */
const validateMeterReading = (current, previous, type = 'km') => {
    // Converte para número seguro
    const curr = parseFloat(current);
    const prev = parseFloat(previous);

    // Se não informou ou é zero, assume que não houve leitura (ou veículo novo) - Passa
    if (isNaN(curr) || curr <= 0) return null; 
    
    // Se não tem histórico anterior, não temos como validar - Passa
    if (isNaN(prev)) return null; 

    // Regra 1: Leitura menor que a anterior
    if (curr < prev) {
        return `${type === 'km' ? 'Odômetro' : 'Horímetro'} menor que o anterior (${prev}).`;
    }

    // Regra 2: Salto excessivo — alinhado com vehicleRules.js (1000 Km / 50 Hr)
    const limit = type === 'km' ? 1000 : 50;
    if ((curr - prev) > limit) {
        return `Salto excessivo de ${type === 'km' ? 'Odômetro' : 'Horímetro'} (> ${limit}). Verifique a digitação.`;
    }

    return null; // Sem erros
};

/**
 * Verifica limites orçamentários (Regra dos 20%)
 */
const checkBudgetLimit = (totalSpent, currentEstimate, contractValue) => {
    if (!contractValue || contractValue <= 0) return true; // Sem contrato, sem limite
    const limit = contractValue * 0.20;
    return (totalSpent + currentEstimate) <= limit;
};

// Exportação compatível com CommonJS (Node) e importável por Bundlers (React)
module.exports = {
    FUEL_TYPES_MAP,
    normalizeFuelType,
    validateMeterReading,
    checkBudgetLimit
};