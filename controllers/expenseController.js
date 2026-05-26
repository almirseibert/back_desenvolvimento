// controllers/expenseController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid'); // Para gerar IDs

// ===================================================================================
// FUNÇÃO AUXILIAR DE PARSE SEGURO (Adicionada localmente)
// ===================================================================================
// Esta função tenta fazer o parse de um campo. Se falhar (ex: é um email
// ou texto simples), ela registra um aviso e retorna o valor padrão (ex: null).
const parseJsonSafe = (field, key, defaultValue = null) => {
    if (field === null || typeof field === 'undefined') return defaultValue;
    if (typeof field === 'object') return field; // Já é um objeto
    if (typeof field !== 'string' || (!field.startsWith('{') && !field.startsWith('['))) {
        // Se não for string ou não parecer JSON, retorna o padrão (evita tentar parsear emails)
        return defaultValue; 
    }

    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : defaultValue;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao analisar o campo '${key}'. Valor problemático:`, field);
        return defaultValue; // Retorna o padrão em caso de erro
    }
};
// ===================================================================================


// --- Função para Criar ou Atualizar Despesas Semanais (Função existente) ---
const createOrUpdateWeeklyFuelExpense = async ({ connection, obraId, date, fuelType, partnerName, valueChange }) => {
    // 1. Condições para não gerar despesa (ex: valor zero)
    if (!valueChange || valueChange === 0) {
        return;
    }

    // 2. Calcular o início e fim da semana (Segunda a Domingo)
    const txDate = new Date(date);
    txDate.setHours(0, 0, 0, 0); 
    const dayOfWeek = txDate.getDay(); 
    const diff = txDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStartDate = new Date(txDate.setDate(diff));
    
    // 3. Montar a descrição e os dados
    const formattedFuelType = (fuelType || 'N/A').replace(/([A-Z])/g, ' $1').toLowerCase();
    const description = `Combustível: ${formattedFuelType} - ${partnerName}`;

    // 4. Procurar por uma despesa existente para essa semana/obra/combustível/posto
    const [querySnapshot] = await connection.execute(
        `SELECT id, amount FROM expenses 
         WHERE obraId = ? AND weekStartDate = ? AND fuelType = ? AND partnerName = ?`,
        [obraId, weekStartDate.toISOString().split('T')[0], fuelType, partnerName]
    );

    if (querySnapshot.length === 0) {
        // Se não existir, CRIA uma nova despesa
        if (valueChange > 0) {
            // Gera um ID para a nova despesa
            const newExpenseId = uuidv4();
            await connection.execute(`INSERT INTO expenses 
                (id, obraId, description, amount, category, createdAt, weekStartDate, fuelType, partnerName, expenseType)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [newExpenseId, obraId, description, valueChange, 'Combustível', new Date(), weekStartDate, fuelType, partnerName, 'Auto (Combustível)']
            );
        }
    } else {
        // Se existir, ATUALIZA o valor (incrementando ou decrementando)
        const existingExpense = querySnapshot[0];
        // *** CORREÇÃO: Garante que 'amount' seja um número antes de somar ***
        const newAmount = (parseFloat(existingExpense.amount) || 0) + valueChange;

        if (newAmount <= 0) { // Se for zero ou negativo
             // Deleta a despesa
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense.id]);
        } else {
            await connection.execute('UPDATE expenses SET amount = ? WHERE id = ?', [newAmount, existingExpense.id]);
        }
    }
};

// --- Função para Listar Todas as Despesas (Função existente) ---
const listExpenses = async (req, res) => {
    try {
        // A tabela 'expenses' deve existir (baseado no seu .sql anterior)
        const [rows] = await db.execute('SELECT * FROM expenses ORDER BY createdAt DESC');
        
        // *** CORREÇÃO DO ERRO 500 ***
        // Trocamos o JSON.parse() inseguro pelo 'parseJsonSafe'
        const expenses = rows.map(exp => ({
            ...exp,
            // Isso vai tentar parsear 'createdBy'. Se falhar (ex: for um email),
            // ele vai retornar o valor padrão (null) e não vai quebrar o servidor.
            createdBy: parseJsonSafe(exp.createdBy, 'createdBy', null)
        }));

        res.json(expenses);
    } catch (error) {
        console.error("Erro ao listar despesas:", error);
        res.status(500).json({ error: 'Erro interno ao listar despesas' });
    }
};

// --- (NOVO) Criar Despesa Manual ---
const createExpense = async (req, res) => {
    // Pega o usuário do middleware de autenticação
    const { id: userId, email: userEmail } = req.user; 
    
    // Dados do frontend
    const { obraId, description, amount, category } = req.body;

    // Validação
    if (!obraId || !description || !amount || !category) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }

    try {
        const newExpenseId = uuidv4(); // Gera o ID no backend
        const createdAt = new Date();
        const createdBy = JSON.stringify({ userId, userEmail });
        const expenseType = "Manual"; // Define o tipo

        const query = `
            INSERT INTO expenses 
            (id, obraId, description, amount, category, createdAt, createdBy, expenseType)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await db.execute(query, [
            newExpenseId,
            obraId,
            description,
            amount,
            category,
            createdAt,
            createdBy,
            expenseType
        ]);

        // SOCKET EMIT
        req.io.emit('server:sync', { targets: ['expenses'] });

        res.status(201).json({ id: newExpenseId, ...req.body, createdAt, createdBy });
    } catch (error) {
        console.error("Erro ao criar despesa manual:", error);
        res.status(500).json({ error: 'Erro ao criar despesa.' });
    }
};

// --- (NOVO) Atualizar Despesa Manual ---
const updateExpense = async (req, res) => {
    const { id } = req.params;
    const { obraId, description, amount, category } = req.body;

    // Validação
    if (!obraId || !description || !amount || !category) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }

    try {
        const query = `
            UPDATE expenses 
            SET obraId = ?, description = ?, amount = ?, category = ?
            WHERE id = ?
        `;
        
        const [result] = await db.execute(query, [
            obraId,
            description,
            amount,
            category,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Despesa não encontrada.' });
        }

        // SOCKET EMIT
        req.io.emit('server:sync', { targets: ['expenses'] });

        res.json({ message: 'Despesa atualizada com sucesso.' });
    } catch (error) {
        console.error("Erro ao atualizar despesa:", error);
        res.status(500).json({ error: 'Erro ao atualizar despesa.' });
    }
};

// --- (NOVO) Deletar Despesa Manual ---
const deleteExpense = async (req, res) => {
    const { id } = req.params;

    try {
        const query = 'DELETE FROM expenses WHERE id = ?';
        const [result] = await db.execute(query, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Despesa não encontrada.' });
        }

        // SOCKET EMIT
        req.io.emit('server:sync', { targets: ['expenses'] });

        res.status(204).end(); // Sucesso, sem conteúdo
    } catch (error) {
        console.error("Erro ao deletar despesa:", error);
        res.status(500).json({ error: 'Erro ao deletar despesa.' });
    }
};


module.exports = {
    createOrUpdateWeeklyFuelExpense,
    listExpenses,
    createExpense,  // Exporta a nova função
    updateExpense,  // Exporta a nova função
    deleteExpense   // Exporta a nova função
};