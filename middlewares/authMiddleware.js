// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const db = require('../database'); // Importação necessária para verificar status em tempo real

const authMiddleware = async (req, res, next) => {
    // 1. Obter o token do cabeçalho
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        // Se não houver cabeçalho, nega acesso
        return res.status(401).json({ error: 'Token não fornecido. Acesso negado.' });
    }

    // O formato é 'Bearer [token]', então dividimos e pegamos o token
    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Formato do token inválido.' });
    }

    try {
        // 2. Verificar e decodificar o token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 3. SEGURANÇA REFORÇADA:
        // Busca dados atualizados do usuário no banco para garantir que não foi bloqueado recentemente
        // e para pegar as flags de permissão de abastecimento mais recentes.
        const [users] = await db.query(
            'SELECT id, email, role, user_type, canAccessRefueling, bloqueado_abastecimento FROM users WHERE id = ?', 
            [decoded.id]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Usuário não encontrado ou removido.' });
        }

        const user = users[0];
        
        // Normaliza o papel do usuário (role ou user_type)
        const userRole = (user.role || user.user_type || '').toLowerCase();

        // 4. Anexar o payload atualizado à requisição
        req.user = {
            id: user.id,
            email: user.email,
            role: userRole, 
            user_type: user.user_type || user.role,
            canAccessRefueling: user.canAccessRefueling === 1,
            bloqueado_abastecimento: user.bloqueado_abastecimento === 1
        };

        // 5. VERIFICAÇÃO DE ACESSO AO MÓDULO SUPERVISOR
        // Se a rota acessada contiver "/supervisor", exige permissão específica
        if (req.originalUrl && req.originalUrl.includes('/supervisor')) {
            const allowedRoles = ['admin', 'supervisor'];
            
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ 
                    error: 'Acesso negado. Apenas Supervisores e Administradores podem acessar este módulo.' 
                });
            }
        }
        
        // 6. Continuar para a próxima função/rota
        next();
    } catch (err) {
        console.error("Erro authMiddleware:", err.message);
        // Se o token for inválido, expirado, ou a verificação falhar
        return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }
};

module.exports = authMiddleware;