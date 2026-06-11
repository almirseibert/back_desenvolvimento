const db = require('../database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ====================================================================
// FUNÇÃO DE LOGIN
// ====================================================================
const login = async (req, res) => {
    // Permite que o frontend mande "email" ou "username" no body
    const { email, username, password } = req.body;
    const loginIdentifier = email || username;

    if (!loginIdentifier || !password) {
        return res.status(400).json({ message: 'E-mail/Usuário e senha são obrigatórios.' });
    }

    if (!process.env.JWT_SECRET) {
        console.error('[login] ERRO CRÍTICO: JWT_SECRET não está definido nas variáveis de ambiente!');
        return res.status(500).json({ message: 'Erro de configuração do servidor.' });
    }

    try {
        // Tenta buscar todas as colunas originais; faz fallback se colunas novas ainda não existirem
        let rows;
        try {
            [rows] = await db.query(
                'SELECT id, name, email, username, password, role, user_type, status, canAccessRefueling, bloqueado_abastecimento, tentativas_falhas_abastecimento, employeeId FROM users WHERE email = ? OR username = ?',
                [loginIdentifier, loginIdentifier]
            );
        } catch (colErr) {
            console.warn('[login] Fallback query (colunas novas ausentes):', colErr.message);
            [rows] = await db.query(
                'SELECT id, username as name, email, username, password, role, status FROM users WHERE email = ? OR username = ?',
                [loginIdentifier, loginIdentifier]
            );
        }

        const user = rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Credenciais inválidas ou usuário não encontrado.' });
        }

        const statusNormalizado = (user.status || '').toString().toLowerCase();
        if (statusNormalizado === 'inativo') {
            return res.status(403).json({ message: 'Cadastro pendente de aprovação pelo administrador.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        const token = jwt.sign(
            { 
                id: user.id, 
                role: user.role, 
                email: user.email,
                username: user.username,
                user_type: user.user_type
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                user_type: user.user_type,
                status: user.status,
                canAccessRefueling: user.canAccessRefueling,
                bloqueado_abastecimento: user.bloqueado_abastecimento,
                employeeId: user.employeeId || null
            }
        });

    } catch (error) {
        console.error('Erro geral no login:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ====================================================================
// REGISTRO DE USUÁRIO
// ====================================================================
const register = async (req, res) => {
    try {
        const { name, email, username, password, role = 'user', user_type = 'Comum' } = req.body;
        const loginIdentifier = email || username;

        if (!loginIdentifier || !password) {
            return res.status(400).json({ message: 'E-mail/Usuário e senha são obrigatórios.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const userId = uuidv4();

        let rows;
        try {
            // Verifica se usuário ou e-mail já existe
            [rows] = await db.query('SELECT id FROM users WHERE email = ? OR username = ?', [email || '', username || '']);
            if (rows.length > 0) {
                return res.status(400).json({ message: 'Usuário ou e-mail já está em uso.' });
            }

            await db.query(
                'INSERT INTO users (id, name, email, username, password, role, user_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [userId, name || loginIdentifier, loginIdentifier, username || loginIdentifier, hashedPassword, role, user_type, 'inativo']
            );
        } catch (colErr) {
            console.warn('[register] Fallback de inserção (usando ID auto incrementado ou faltando colunas):', colErr.message);
            await db.query(
                'INSERT INTO users (name, email, username, password, role, status) VALUES (?, ?, ?, ?, ?, ?)',
                [name || loginIdentifier, loginIdentifier, username || loginIdentifier, hashedPassword, role, 'inativo']
            );
        }

        // Notifica administradores (pop-up + som) sobre a nova solicitação de cadastro.
        if (req.io) {
            req.io.emit('server:sync', { targets: ['admin_requests'] });
            req.io.emit('admin:notificacao', { tipo: 'nova_solicitacao_cadastro' });
        }

        res.status(201).json({ message: 'Solicitação de cadastro enviada. Aguarde a aprovação do administrador para acessar o sistema.' });

    } catch (error) {
        console.error('Erro geral no registro:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Usuário ou e-mail já existe.' });
        }
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
};

// ====================================================================
// OBTER DADOS DO USUÁRIO LOGADO (GET ME)
// ====================================================================
const getMe = async (req, res) => {
    try {
        let rows;
        try {
            [rows] = await db.query(
                'SELECT id, name, email, username, role, user_type, status, canAccessRefueling, bloqueado_abastecimento, employeeId FROM users WHERE id = ?',
                [req.user.id]
            );
        } catch (colErr) {
            [rows] = await db.query(
                'SELECT id, username as name, email, username, role, status FROM users WHERE id = ?',
                [req.user.id]
            );
        }

        const user = rows[0];

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado' });
        }
        res.status(200).json(user);
    } catch (error) {
        console.error('Erro na rota /me:', error);
        res.status(500).json({ message: 'Erro interno do servidor' });
    }
};

// ====================================================================
// TROCAR SENHA
// ====================================================================
const changePassword = async (req, res) => {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Preencha a senha atual e a nova senha.' });
    }

    try {
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(401).json({ message: 'A senha atual está incorreta.' });

        const salt = await bcrypt.genSalt(10);
        const hashedNewPassword = await bcrypt.hash(newPassword, salt);

        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, userId]);

        res.status(200).json({ message: 'Senha alterada com sucesso.' });

    } catch (error) {
        console.error('Erro ao trocar senha:', error);
        res.status(500).json({ message: 'Erro interno.' });
    }
};

// ====================================================================
// VALIDAR SENHA
// ====================================================================
const validatePassword = async (req, res) => {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ message: 'A senha é obrigatória.' });
    }

    try {
        const [rows] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            return res.status(401).json({ message: 'Senha incorreta.', valid: false });
        }

        res.status(200).json({ message: 'Senha válida.', valid: true });

    } catch (error) {
        console.error('Erro ao validar senha:', error);
        res.status(500).json({ message: 'Erro interno ao validar senha.', valid: false });
    }
};

module.exports = {
    login,
    register,
    getMe,
    changePassword,
    validatePassword
};