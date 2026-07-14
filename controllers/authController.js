const db = require('../database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ====================================================================
// CONFIGURAÇÃO DE SESSÃO
// ====================================================================
// Access token curto (renovado silenciosamente pelo frontend via refresh token).
// Refresh token longo e revogável (guardado com hash no banco).
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '4h';
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Assina o access token JWT com o payload padrão do usuário.
const signAccessToken = (user) => jwt.sign(
    {
        id: user.id,
        role: user.role,
        email: user.email,
        username: user.username,
        user_type: user.user_type
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
);

// Gera um refresh token opaco, guarda o hash no banco e devolve o valor cru.
const issueRefreshToken = async (userId) => {
    const raw = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [uuidv4(), String(userId), hashToken(raw), expiresAt]
    );
    return raw;
};

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

        const token = signAccessToken(user);
        const refreshToken = await issueRefreshToken(user.id);

        res.status(200).json({
            token,
            refreshToken,
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
                'SELECT id, name, email, username, role, user_type, status, canAccessRefueling, canAccessAnaliseGerencial, bloqueado_abastecimento, employeeId FROM users WHERE id = ?',
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

// ====================================================================
// RENOVAR SESSÃO (REFRESH TOKEN)
// ====================================================================
// Recebe um refresh token válido e devolve um novo access token, rotacionando
// o refresh token (o antigo é revogado). Rota PÚBLICA — o access token já
// pode estar expirado neste momento.
const refresh = async (req, res) => {
    const { refreshToken } = req.body || {};

    if (!refreshToken) {
        return res.status(400).json({ error: 'refreshToken é obrigatório.' });
    }

    try {
        const [rows] = await db.query(
            'SELECT id, user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?',
            [hashToken(refreshToken)]
        );
        const stored = rows[0];

        if (!stored || stored.revoked === 1 || new Date(stored.expires_at) < new Date()) {
            return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.', code: 'REFRESH_INVALID' });
        }

        // Busca o usuário para garantir que ainda existe e está ativo.
        let userRows;
        try {
            [userRows] = await db.query(
                'SELECT id, email, username, role, user_type, status FROM users WHERE id = ?',
                [stored.user_id]
            );
        } catch (colErr) {
            [userRows] = await db.query(
                'SELECT id, email, username, role, status FROM users WHERE id = ?',
                [stored.user_id]
            );
        }
        const user = userRows[0];

        if (!user) {
            await db.query('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [stored.id]);
            return res.status(401).json({ error: 'Usuário não encontrado.', code: 'REFRESH_INVALID' });
        }
        if ((user.status || '').toString().toLowerCase() === 'inativo') {
            await db.query('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [stored.id]);
            return res.status(403).json({ error: 'Cadastro inativo.' });
        }

        // Rotação: revoga o refresh atual e emite um novo (mitiga replay).
        await db.query('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [stored.id]);
        const newToken = signAccessToken(user);
        const newRefreshToken = await issueRefreshToken(user.id);

        res.status(200).json({ token: newToken, refreshToken: newRefreshToken });

    } catch (error) {
        console.error('Erro ao renovar sessão:', error);
        res.status(500).json({ error: 'Erro interno ao renovar sessão.' });
    }
};

// ====================================================================
// LOGOUT (REVOGA REFRESH TOKEN)
// ====================================================================
// Rota PÚBLICA — best-effort. Nunca falha o logout do cliente por causa disso.
const logout = async (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
        try {
            await db.query('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [hashToken(refreshToken)]);
        } catch (error) {
            console.warn('⚠️ Erro ao revogar refresh token no logout:', error.message);
        }
    }
    res.status(200).json({ ok: true });
};

module.exports = {
    login,
    register,
    getMe,
    changePassword,
    validatePassword,
    refresh,
    logout
};