// Este é um novo arquivo que você deve criar na pasta 'utils' do seu backend
// (ex: backend/utils/parseJsonSafe.js)
// Ele ajuda a evitar que a API quebre se houver dados JSON mal formatados no banco de dados.

const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    
    // Se já for um objeto/array (por exemplo, se o driver do MySQL já parseou)
    if (typeof field === 'object') return field; 
    
    // Garante que é uma string antes de tentar o parse
    if (typeof field !== 'string') return field;

    try {
        // Tenta fazer o parse da string
        const parsed = JSON.parse(field);
        
        // Verifica se o resultado do parse é um objeto/array válido
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        // Retorna null em caso de erro, impedindo a quebra da aplicação.
        return null; 
    }
};

module.exports = {
    parseJsonSafe
};