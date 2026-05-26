const db = require('../database');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

// --- Função Auxiliar para Conversar com o Banco de Dados ---
const parseAdminJsonFields = (data) => {
    if (!data) return null;
    if (data.ultimaAlteracao) data.ultimaAlteracao = JSON.parse(data.ultimaAlteracao);
    return data;
};

// --- ROTA: Buscar a lista de solicitações de cadastro ---
// Busca na tabela 'users' onde status é 'inativo'
const getRegistrationRequests = async (req, res) => {
    try {
        // Seleciona apenas os campos necessários. 
        // O alias 'created_at' mapeia para 'data_criacao' se existir, ou null.
        const [rows] = await db.execute("SELECT id, name, email, data_criacao as created_at FROM users WHERE status = 'inativo' ORDER BY data_criacao DESC");
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar solicitações de cadastro:', error);
        res.status(500).json({ error: 'Erro ao buscar solicitações de cadastro' });
    }
};

// --- ROTA: Aprovar uma solicitação e ativar o usuário ---
const approveRegistrationRequest = async (req, res) => {
    const { userId, role, canAccessRefueling } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "ID do usuário é obrigatório." });
    }

    try {
        // Atualiza o usuário existente para 'ativo'
        // Define role, user_type (para compatibilidade) e permissão de abastecimento
        // ATENÇÃO: A query usa 'status' (varchar) e 'canAccessRefueling' (tinyint)
        
        const roleToSet = role || 'operador';
        const accessValue = canAccessRefueling ? 1 : 0;

        // Se sua tabela tem 'user_status', atualizamos ele também para garantir
        // Mas como vimos que sua tabela só tem 'status', focamos nele.
        // Adiciono 'user_status' na query apenas se a coluna existir, mas para segurança vou remover e focar no padrão.
        // Se precisar de 'user_status', adicione: user_status = 'ativo',
        
        await db.execute(
            `UPDATE users 
             SET status = 'ativo', 
                 role = ?, 
                 user_type = ?,
                 canAccessRefueling = ? 
             WHERE id = ?`,
            [roleToSet, roleToSet, accessValue, userId]
        );

        res.status(200).json({ message: 'Usuário aprovado e ativado com sucesso.' });
    } catch (error) {
        console.error('Erro ao aprovar solicitação (UPDATE users):', error);
        res.status(500).json({ error: 'Erro interno ao aprovar solicitação.' });
    }
};

// --- ROTA: Rejeitar uma solicitação ---
const deleteRegistrationRequest = async (req, res) => {
    const { id } = req.params;
    try {
        // Deleta o usuário da tabela 'users' apenas se ele estiver inativo (segurança)
        await db.execute("DELETE FROM users WHERE id = ? AND status = 'inativo'", [id]);
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao rejeitar solicitação:', error);
        res.status(500).json({ error: 'Erro ao rejeitar solicitação.' });
    }
};

// --- ROTA: Atribuir um papel a um usuário existente ---
const assignRole = async (req, res) => {
    const { email, role, canAccessRefueling } = req.body;
    try {
        await db.execute('UPDATE users SET role = ?, user_type = ?, canAccessRefueling = ? WHERE email = ?', 
            [role, role, canAccessRefueling ? 1 : 0, email]);
        res.status(200).json({ message: `Permissões de ${email} atualizadas com sucesso.` });
    } catch (error) {
        console.error('Erro ao atribuir papel:', error);
        res.status(500).json({ error: 'Erro ao atribuir papel.' });
    }
};

// --- ROTA: Obter a mensagem de atualização do sistema ---
const getUpdateMessage = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM updates ORDER BY timestamp DESC LIMIT 1');
        if (rows.length === 0) {
            return res.json({ message: '', showPopup: false });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao obter mensagem de atualização:', error);
        res.status(500).json({ error: 'Erro ao obter mensagem de atualização.' });
    }
};

// --- ROTA: Salvar a mensagem de atualização do sistema ---
const saveUpdateMessage = async (req, res) => {
    const { message, showPopup } = req.body;
    try {
        await db.execute('INSERT INTO updates (message, showPopup, timestamp) VALUES (?, ?, ?)',
            [message, showPopup, new Date()]);
        res.status(200).json({ message: 'Mensagem de atualização salva com sucesso.' });
    } catch (error) {
        console.error('Erro ao salvar mensagem de atualização:', error);
        res.status(500).json({ error: 'Erro ao salvar mensagem de atualização.' });
    }
};

// --- ROTA: Migrar funcionários (que não têm user) para usuários ---
const adminMigrateUsers = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [employeesToMigrate] = await connection.execute(
            "SELECT id, nome, registroInterno FROM employees WHERE status = 'ativo' AND userId IS NULL"
        );

        let migratedCount = 0;

        for (const employee of employeesToMigrate) {
            if (!employee.registroInterno) continue;

            const newUserId = uuidv4();
            const defaultPassword = 'mak123'; 
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            const email = `${employee.registroInterno.toLowerCase()}@frotasmak.com.br`;

            // Query ajustada para a estrutura da tabela users
            await connection.execute(
                `INSERT INTO users (id, email, password, role, user_type, status, employeeId, name, canAccessRefueling, data_criacao) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [newUserId, email, hashedPassword, 'operador', 'operador', 'ativo', employee.id, employee.nome, 0]
            );

            await connection.execute(
                `UPDATE employees SET userId = ? WHERE id = ?`,
                [newUserId, employee.id]
            );
            
            migratedCount++;
        }

        await connection.commit();
        res.status(200).json({ message: `Migração concluída! ${migratedCount} usuários foram criados e vinculados.` });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao migrar usuários:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(500).json({ error: 'Erro de Duplicidade: Um dos emails gerados já existe.' });
        }
        res.status(500).json({ error: 'Erro interno ao migrar usuários.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getRegistrationRequests,
    approveRegistrationRequest,
    deleteRegistrationRequest,
    assignRole,
    getUpdateMessage,
    saveUpdateMessage,
    adminMigrateUsers
};