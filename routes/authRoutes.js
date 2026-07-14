const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');
const db = require('../database');

// --- ROTAS PÚBLICAS ---
router.post('/login', authController.login);
router.post('/register', authController.register);
// Renovação silenciosa de sessão e logout (revogação). Públicas de propósito:
// o access token pode já estar expirado quando o cliente as chama.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

// --- ROTAS PROTEGIDAS ---
// 🚨 Rota comentada para corrigir o TypeError (a função validatePassword não existe no controller)
router.post('/validate-password', authMiddleware, authController.validatePassword);

router.post('/change-password', authMiddleware, authController.changePassword);

router.get('/me', authMiddleware, async (req, res) => {
    const userId = req.user.id; 

    if (!userId) return res.status(401).json({ error: 'Token inválido.' });

    try {
        // CORREÇÃO: Busca campos novos de bloqueio e tentativas
        const [rows] = await db.query(
            `SELECT id, name, email, role, user_type, status, 
                    canAccessRefueling, 
                    bloqueado_abastecimento, 
                    tentativas_falhas_abastecimento 
             FROM users WHERE id = ?`, 
            [userId]
        );
        const user = rows[0];

        if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

        // Normalização de campos para o frontend
        const userProfile = {
            ...user,
            role: user.role || user.user_type, // Garante compatibilidade
            canAccessRefueling: user.canAccessRefueling === 1,
            bloqueado_abastecimento: user.bloqueado_abastecimento === 1, // Garante booleano
            tentativas_falhas_abastecimento: user.tentativas_falhas_abastecimento || 0
        };

        res.json(userProfile);

    } catch (error) {
        console.error('Erro em /me:', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// --- Push tokens do app mobile (Seção 11) ---
// Registra (upsert) o Expo push token do dispositivo para o usuário logado.
router.post('/push-token', authMiddleware, async (req, res) => {
    const userId = req.user?.id;
    const { token, platform } = req.body || {};
    if (!userId) return res.status(401).json({ error: 'Token inválido.' });
    if (!token) return res.status(400).json({ error: 'token é obrigatório.' });

    try {
        // Token é único: reatribui ao usuário atual se o aparelho trocar de login.
        await db.query(
            `INSERT INTO user_push_tokens (user_id, token, platform)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform)`,
            [userId, token, platform || null]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error('Erro ao registrar push token:', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// Remove o token (logout) para parar de receber pushes neste aparelho.
router.delete('/push-token', authMiddleware, async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token é obrigatório.' });
    try {
        await db.query('DELETE FROM user_push_tokens WHERE token = ?', [token]);
        res.json({ ok: true });
    } catch (error) {
        console.error('Erro ao remover push token:', error);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

module.exports = router;