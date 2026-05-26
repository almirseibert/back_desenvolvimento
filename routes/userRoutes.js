const express = require('express');
const router = express.Router();
const db = require('../database');
const authMiddleware = require('../middlewares/authMiddleware');

// Listar todos os usuários (necessário para CommunicationTab e UserManagementTab)
router.get('/', authMiddleware, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.name, u.email, u.user_type, u.role, u.status,
                   u.canAccessRefueling AS podeAcessarAbastecimento,
                   u.group_id, g.name AS group_name,
                   u.bloqueado_abastecimento, u.tentativas_falhas_abastecimento
            FROM users u
            LEFT JOIN access_groups g ON u.group_id = g.id
            ORDER BY u.name ASC
        `);
        res.json(rows.map(u => ({ ...u, podeAcessarAbastecimento: !!u.podeAcessarAbastecimento })));
    } catch (error) {
        // Se access_groups ainda não existe, retorna sem o JOIN
        try {
            const [rows] = await db.query(
                `SELECT id, name, email, user_type, role, status,
                        canAccessRefueling AS podeAcessarAbastecimento
                 FROM users ORDER BY name ASC`
            );
            res.json(rows.map(u => ({ ...u, podeAcessarAbastecimento: !!u.podeAcessarAbastecimento })));
        } catch (err) {
            console.error('Erro ao listar usuários:', err);
            res.status(500).json({ error: 'Erro ao listar usuários.' });
        }
    }
});

// Rota GET /api/users/profile
router.get('/profile', authMiddleware, async (req, res) => {
    // O token JWT contém `id` (o ID do utilizador no banco de dados).
    const userId = req.user.id; 
    
    if (!userId) {
        return res.status(401).json({ message: 'Token de autenticação inválido ou faltando dados.' });
    }

    try {
        // --- CÓDIGO CORRIGIDO ---
        // A consulta foi alterada para buscar 'canAccessRefueling' da tabela 'users' (u)
        // e o LEFT JOIN com a tabela 'employees' foi removido por ser desnecessário aqui.
        const [rows] = await db.query(
            `SELECT 
                u.id, 
                u.email, 
                u.role, 
                u.name, 
                u.phone,
                u.canAccessRefueling
            FROM users u
            WHERE u.id = ?`, 
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Perfil do utilizador não encontrado.' });
        }

        const userProfile = rows[0];

        // Converte o valor do DB (0 ou 1) para o booleano esperado pelo frontend
        res.json({
            ...userProfile,
            canAccessRefueling: userProfile.canAccessRefueling === 1,
        });

    } catch (error) {
        console.error('Erro ao buscar perfil do utilizador:', error);
        res.status(500).json({ message: 'Erro interno do servidor ao buscar o perfil.' });
    }
});

module.exports = router;
