// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');
const db = require('../database');
const whatsappService = require('../services/whatsappService');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

router.use(authMiddleware);

const adminOnly = (req, res, next) => {
    if (req.user.user_type !== 'admin') {
        return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    next();
};

// ─── INICIALIZAÇÃO DAS TABELAS ADMIN ─────────────────────────────────────────
const initAdminTables = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS access_groups (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description VARCHAR(255) NULL,
                modules JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                value LONGTEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS message_templates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_holidays (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                date DATE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                module VARCHAR(50) NOT NULL,
                frequency VARCHAR(20) NOT NULL DEFAULT 'weekly',
                time VARCHAR(10) NOT NULL DEFAULT '08:00',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Adicionar group_id na tabela users se não existir
        try {
            const [cols] = await db.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'group_id'`
            );
            if (cols.length === 0) {
                await db.query(`ALTER TABLE users ADD COLUMN group_id VARCHAR(36) NULL`);
                console.log('✅ Coluna group_id adicionada à tabela users.');
            }
        } catch (colErr) {
            console.warn('⚠️ Não foi possível adicionar group_id:', colErr.message);
        }
        console.log('✅ Tabelas admin inicializadas com sucesso.');
    } catch (err) {
        console.warn('⚠️ Erro ao inicializar tabelas admin:', err.message);
    }
};

initAdminTables();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const getSetting = async (key, defaultValue = null) => {
    const [rows] = await db.query('SELECT value FROM admin_settings WHERE setting_key = ?', [key]);
    if (rows.length === 0) return defaultValue;
    try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
};

const saveSetting = async (key, value) => {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    await db.query(
        'INSERT INTO admin_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
        [key, json, json]
    );
};

// ─── ROTAS EXISTENTES (via Controller) ────────────────────────────────────────
router.get('/registration-requests', adminController.getRegistrationRequests);
router.post('/registration-requests/approve', adminController.approveRegistrationRequest);
router.delete('/registration-requests/:id', adminController.deleteRegistrationRequest);
router.put('/assign-role', adminController.assignRole);
router.get('/update-message', adminController.getUpdateMessage);
router.put('/update-message', adminController.saveUpdateMessage);
router.post('/migrate-users', adminController.adminMigrateUsers);

// ─── USUÁRIOS ─────────────────────────────────────────────────────────────────

// Listar todos os usuários
router.get('/users', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.name, u.email, u.role, u.user_type, u.status,
                   u.canAccessRefueling AS podeAcessarAbastecimento,
                   u.bloqueado_abastecimento, u.tentativas_falhas_abastecimento,
                   u.group_id, g.name AS group_name
            FROM users u
            LEFT JOIN access_groups g ON u.group_id = g.id
            ORDER BY u.name ASC
        `);
        res.json(rows.map(u => ({ ...u, podeAcessarAbastecimento: !!u.podeAcessarAbastecimento })));
    } catch (error) {
        console.error('Erro ao listar usuários:', error);
        res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

// Criar novo usuário
router.post('/users', adminOnly, async (req, res) => {
    const { name, email, password, user_type, group_id, podeAcessarAbastecimento, canAccessRefueling } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    const canRefuel = !!(podeAcessarAbastecimento || canAccessRefueling);
    try {
        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(409).json({ error: 'E-mail já cadastrado.' });

        const id = uuidv4();
        const hashed = await bcrypt.hash(password, 10);
        const role = user_type || 'viewer';

        await db.query(
            `INSERT INTO users (id, name, email, password, role, user_type, status, canAccessRefueling, group_id, data_criacao)
             VALUES (?, ?, ?, ?, ?, ?, 'ativo', ?, ?, NOW())`,
            [id, name, email, hashed, role, role, canRefuel ? 1 : 0, group_id || null]
        );
        res.status(201).json({ id, message: 'Usuário criado com sucesso.' });
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        res.status(500).json({ error: 'Erro ao criar usuário.' });
    }
});

// Atualizar usuário (PATCH — usado pelo UserEditModal)
router.patch('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, email, password, user_type, group_id, podeAcessarAbastecimento, canAccessRefueling, active } = req.body;
    const canRefuel = podeAcessarAbastecimento !== undefined ? podeAcessarAbastecimento
                    : canAccessRefueling !== undefined ? canAccessRefueling : undefined;
    try {
        const sets = [];
        const params = [];

        if (name !== undefined)     { sets.push('name = ?');               params.push(name); }
        if (email !== undefined)    { sets.push('email = ?');              params.push(email); }
        if (user_type !== undefined){ sets.push('role = ?, user_type = ?');params.push(user_type, user_type); }
        if (group_id !== undefined) { sets.push('group_id = ?');           params.push(group_id || null); }
        if (canRefuel !== undefined){ sets.push('canAccessRefueling = ?'); params.push(canRefuel ? 1 : 0); }
        if (active !== undefined)   { sets.push('status = ?');             params.push(active ? 'ativo' : 'inativo'); }
        if (password) {
            const hashed = await bcrypt.hash(password, 10);
            sets.push('password = ?');
            params.push(hashed);
        }

        if (sets.length === 0) return res.json({ message: 'Nada para atualizar.' });

        params.push(id);
        await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// Toggle status ativo / inativo
router.patch('/users/:id/status', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query('SELECT status FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        const newStatus = rows[0].status === 'ativo' ? 'inativo' : 'ativo';
        await db.query('UPDATE users SET status = ? WHERE id = ?', [newStatus, id]);
        res.json({ status: newStatus, message: `Usuário ${newStatus}.` });
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.status(500).json({ error: 'Erro ao alterar status do usuário.' });
    }
});

// Reset de senha (gera senha temporária)
router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashed = await bcrypt.hash(tempPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, id]);
        res.json({ message: 'Senha redefinida com sucesso.', temporaryPassword: tempPassword });
    } catch (error) {
        console.error('Erro ao resetar senha:', error);
        res.status(500).json({ error: 'Erro ao redefinir senha.' });
    }
});

// Atualizar usuário (PUT — compatibilidade com rota legada)
router.put('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, email, role, user_type, canAccessRefueling } = req.body;
    try {
        await db.query(
            'UPDATE users SET name = ?, email = ?, role = ?, user_type = ?, canAccessRefueling = ? WHERE id = ?',
            [name, email, role, user_type, canAccessRefueling ? 1 : 0, id]
        );
        res.json({ message: 'Usuário atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário.' });
    }
});

// Excluir usuário
router.delete('/users/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        if (id === String(req.user.id)) {
            return res.status(400).json({ error: 'Não é possível excluir a si mesmo.' });
        }
        await db.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'Usuário excluído.' });
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        res.status(500).json({ error: 'Erro ao excluir usuário.' });
    }
});

// Desbloquear usuário (abastecimento)
router.put('/users/:id/unlock', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query(
            'UPDATE users SET bloqueado_abastecimento = 0, tentativas_falhas_abastecimento = 0 WHERE id = ?',
            [id]
        );
        res.json({ message: 'Usuário desbloqueado para solicitações de abastecimento.' });
    } catch (error) {
        console.error('Erro ao desbloquear usuário:', error);
        res.status(500).json({ error: 'Erro ao desbloquear usuário.' });
    }
});

// ─── GRUPOS DE ACESSO ─────────────────────────────────────────────────────────

router.get('/groups', adminOnly, async (req, res) => {
    try {
        const [groups] = await db.query('SELECT * FROM access_groups ORDER BY name ASC');
        const [counts] = await db.query(
            'SELECT group_id, COUNT(*) AS userCount FROM users WHERE group_id IS NOT NULL GROUP BY group_id'
        );
        const countMap = Object.fromEntries(counts.map(r => [r.group_id, Number(r.userCount)]));
        res.json(groups.map(g => ({
            ...g,
            modules: typeof g.modules === 'string' ? JSON.parse(g.modules || '[]') : (g.modules || []),
            userCount: countMap[g.id] || 0,
        })));
    } catch (error) {
        console.error('Erro ao listar grupos:', error);
        res.status(500).json({ error: 'Erro ao listar grupos.' });
    }
});

router.post('/groups', adminOnly, async (req, res) => {
    const { name, description, modules } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        const id = uuidv4();
        await db.query(
            'INSERT INTO access_groups (id, name, description, modules) VALUES (?, ?, ?, ?)',
            [id, name, description || null, JSON.stringify(modules || [])]
        );
        res.status(201).json({ id, name, description: description || null, modules: modules || [], userCount: 0 });
    } catch (error) {
        console.error('Erro ao criar grupo:', error);
        res.status(500).json({ error: 'Erro ao criar grupo.' });
    }
});

router.patch('/groups/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, description, modules } = req.body;
    try {
        const sets = [];
        const params = [];
        if (name !== undefined)        { sets.push('name = ?');        params.push(name); }
        if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
        if (modules !== undefined)     { sets.push('modules = ?');     params.push(JSON.stringify(modules)); }
        if (sets.length === 0) return res.json({ message: 'Nada para atualizar.' });
        params.push(id);
        await db.query(`UPDATE access_groups SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'Grupo atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar grupo:', error);
        res.status(500).json({ error: 'Erro ao atualizar grupo.' });
    }
});

router.delete('/groups/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('UPDATE users SET group_id = NULL WHERE group_id = ?', [id]);
        await db.query('DELETE FROM access_groups WHERE id = ?', [id]);
        res.json({ message: 'Grupo removido.' });
    } catch (error) {
        console.error('Erro ao remover grupo:', error);
        res.status(500).json({ error: 'Erro ao remover grupo.' });
    }
});

// ─── CONFIGURAÇÃO DE E-MAIL ───────────────────────────────────────────────────

router.get('/email-config', adminOnly, async (req, res) => {
    try {
        const config = await getSetting('email_config', {
            host: '', port: 587, user: '', password: '',
            fromAddress: '', fromName: 'MAK Frotas', tls: true,
        });
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar configuração de e-mail.' });
    }
});

router.put('/email-config', adminOnly, async (req, res) => {
    try {
        await saveSetting('email_config', req.body);
        res.json({ message: 'Configuração de e-mail salva com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar configuração de e-mail.' });
    }
});

router.post('/email-config/test', adminOnly, async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Destinatário é obrigatório.' });
    try {
        const config = await getSetting('email_config', {});
        if (!config.host || !config.user) {
            return res.status(400).json({ error: 'Configure o SMTP antes de enviar o teste.' });
        }
        const nodemailer = require('nodemailer');
        const port = Number(config.port) || 587;
        const transporter = nodemailer.createTransport({
            host: config.host,
            port,
            secure: port === 465, // SSL direto só na 465; 587 usa STARTTLS (secure: false)
            auth: { user: config.user, pass: config.password },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
        });
        await transporter.sendMail({
            from: `"${config.fromName || 'MAK Frotas'}" <${config.fromAddress || config.user}>`,
            to,
            subject: 'Teste de e-mail — MAK Frotas',
            text: 'Este é um e-mail de teste enviado pelo sistema MAK Frotas. Se recebeu, a configuração está correta.',
        });
        res.json({ message: 'E-mail de teste enviado com sucesso.' });
    } catch (error) {
        console.error('Erro ao enviar e-mail de teste:', error);
        res.status(500).json({ error: 'Erro ao enviar e-mail: ' + error.message });
    }
});

// ─── ROTEAMENTO DE NOTIFICAÇÕES ───────────────────────────────────────────────

router.get('/notification-routing', adminOnly, async (req, res) => {
    try {
        const routing = await getSetting('notification_routing', {});
        res.json(routing);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar roteamento de notificações.' });
    }
});

router.put('/notification-routing', adminOnly, async (req, res) => {
    try {
        await saveSetting('notification_routing', req.body);
        res.json({ message: 'Roteamento de notificações salvo com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar roteamento de notificações.' });
    }
});

// ─── TEMPLATES DE MENSAGEM ────────────────────────────────────────────────────

router.get('/message-templates', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM message_templates ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar templates.' });
    }
});

router.post('/message-templates', adminOnly, async (req, res) => {
    const { name, channel, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Nome e conteúdo são obrigatórios.' });
    try {
        const [result] = await db.query(
            'INSERT INTO message_templates (name, channel, content) VALUES (?, ?, ?)',
            [name, channel || 'whatsapp', content]
        );
        res.status(201).json({ id: result.insertId, name, channel: channel || 'whatsapp', content });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar template.' });
    }
});

router.put('/message-templates/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, channel, content } = req.body;
    try {
        await db.query(
            'UPDATE message_templates SET name = ?, channel = ?, content = ? WHERE id = ?',
            [name, channel, content, id]
        );
        res.json({ message: 'Template atualizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar template.' });
    }
});

router.delete('/message-templates/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM message_templates WHERE id = ?', [id]);
        res.json({ message: 'Template removido.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao remover template.' });
    }
});

// ─── CONFIGURAÇÃO DE ALERTAS ──────────────────────────────────────────────────

router.get('/alert-config', adminOnly, async (req, res) => {
    try {
        const config = await getSetting('alert_config', {});
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar configuração de alertas.' });
    }
});

router.put('/alert-config', adminOnly, async (req, res) => {
    try {
        await saveSetting('alert_config', req.body);
        res.json({ message: 'Configuração de alertas salva com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar configuração de alertas.' });
    }
});

// ─── RELATÓRIOS PROGRAMADOS ───────────────────────────────────────────────────

router.get('/scheduled-reports', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM admin_scheduled_reports ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar relatórios programados.' });
    }
});

router.post('/scheduled-reports', adminOnly, async (req, res) => {
    const { name, module, frequency, time } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
        const [result] = await db.query(
            'INSERT INTO admin_scheduled_reports (name, module, frequency, time) VALUES (?, ?, ?, ?)',
            [name, module || 'Abastecimento', frequency || 'weekly', time || '08:00']
        );
        res.status(201).json({ id: result.insertId, name, module, frequency, time });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar relatório programado.' });
    }
});

router.put('/scheduled-reports/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    const { name, module, frequency, time } = req.body;
    try {
        await db.query(
            'UPDATE admin_scheduled_reports SET name = ?, module = ?, frequency = ?, time = ? WHERE id = ?',
            [name, module, frequency, time, id]
        );
        res.json({ message: 'Relatório atualizado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar relatório.' });
    }
});

router.delete('/scheduled-reports/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM admin_scheduled_reports WHERE id = ?', [id]);
        res.json({ message: 'Relatório removido.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao remover relatório.' });
    }
});

// ─── WORKFLOWS DE APROVAÇÃO ───────────────────────────────────────────────────

router.get('/approval-workflows', adminOnly, async (req, res) => {
    try {
        const workflows = await getSetting('approval_workflows', []);
        res.json(workflows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar workflows de aprovação.' });
    }
});

router.put('/approval-workflows', adminOnly, async (req, res) => {
    try {
        await saveSetting('approval_workflows', req.body);
        res.json({ message: 'Workflows de aprovação salvos com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar workflows de aprovação.' });
    }
});

// ─── FERIADOS ─────────────────────────────────────────────────────────────────

router.get('/holidays', adminOnly, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM admin_holidays ORDER BY date ASC');
        res.json(rows.map(h => ({
            ...h,
            date: h.date instanceof Date ? h.date.toISOString().slice(0, 10) : h.date,
        })));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar feriados.' });
    }
});

router.post('/holidays', adminOnly, async (req, res) => {
    const { name, date } = req.body;
    if (!name || !date) return res.status(400).json({ error: 'Nome e data são obrigatórios.' });
    try {
        const [result] = await db.query(
            'INSERT INTO admin_holidays (name, date) VALUES (?, ?)',
            [name, date]
        );
        res.status(201).json({ id: result.insertId, name, date });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar feriado.' });
    }
});

router.delete('/holidays/:id', adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM admin_holidays WHERE id = ?', [id]);
        res.json({ message: 'Feriado removido.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao remover feriado.' });
    }
});

// ─── BROADCAST ────────────────────────────────────────────────────────────────

router.post('/broadcast', adminOnly, async (req, res) => {
    const { message, target, channels } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    if (!channels || channels.length === 0) return res.status(400).json({ error: 'Selecione ao menos um canal.' });
    try {
        if (channels.includes('inapp') && global.io) {
            global.io.emit('server:broadcast', {
                message,
                target: target || 'all',
                sentAt: new Date().toISOString(),
                sentBy: req.user.name || req.user.email,
            });
        }
        // Canais whatsapp e email requerem integração adicional (implementar conforme necessidade)
        res.json({ message: 'Broadcast enviado com sucesso.' });
    } catch (error) {
        console.error('Erro ao enviar broadcast:', error);
        res.status(500).json({ error: 'Erro ao enviar broadcast.' });
    }
});

// ─── STATUS DO SISTEMA ────────────────────────────────────────────────────────

router.get('/system/health', adminOnly, async (req, res) => {
    const health = { api: 'ok', whatsapp: 'unknown', socket: 'unknown' };
    const usage = {};

    try {
        await db.query('SELECT 1');
        health.api = 'ok';
    } catch {
        health.api = 'error';
    }

    try {
        const status = await whatsappService.getStatus?.();
        health.whatsapp = status?.connected ? 'ok' : 'error';
    } catch {
        health.whatsapp = 'unknown';
    }

    health.socket = global.io ? 'ok' : 'error';

    try {
        const [activeUsers] = await db.query("SELECT COUNT(*) AS count FROM users WHERE status = 'ativo'");
        usage.activeUsers = activeUsers[0].count;
        usage.uptime = `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`;
        usage.requestsPerHour = '-';
        usage.todaySessions = '-';
    } catch (_) {}

    res.json({ ...health, usage });
});

router.get('/usage-stats', adminOnly, async (req, res) => {
    try {
        const [activeUsers] = await db.query("SELECT COUNT(*) AS count FROM users WHERE status = 'ativo'");
        res.json({
            activeUsers: activeUsers[0].count,
            todaySessions: '-',
            requestsPerHour: '-',
            uptime: `${Math.floor(process.uptime() / 3600)}h`,
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
    }
});

// ─── LOG DE AUDITORIA (stub — implementar conforme necessidade) ───────────────

router.get('/audit-log', adminOnly, async (req, res) => {
    res.json([]);
});

// ─── COMBOIO → PARTNERS (espelho de posto para cada veículo-comboio) ─────────

const {
    ensureComboioPartner,
    deactivateComboioPartner,
    syncAllComboioPartners,
    buildComboioPartnerId,
} = require('../utils/ensureComboioPartner');
const { listPeriods: listComboioPeriods } = require('../utils/comboioPeriodo');

// Lista todos os veículos-comboio com o status do seu partner-espelho
router.get('/comboios', adminOnly, async (req, res) => {
    try {
        const [vehicles] = await db.query(
            `SELECT id, placa, registroInterno, modelo, status, isComboioVehicle, fuelLevels
             FROM vehicles
             WHERE isComboioVehicle = 1
             ORDER BY registroInterno ASC`
        );
        const partnerIds = vehicles.map(v => buildComboioPartnerId(v.id));
        let partnersMap = {};
        if (partnerIds.length > 0) {
            const placeholders = partnerIds.map(() => '?').join(',');
            const [partnerRows] = await db.query(
                `SELECT id, razaoSocial, status_operacional, telefone, whatsapp, email
                 FROM partners WHERE id IN (${placeholders})`,
                partnerIds
            );
            partnersMap = Object.fromEntries(partnerRows.map(p => [p.id, p]));
        }
        const result = vehicles.map(v => {
            const pid = buildComboioPartnerId(v.id);
            return {
                vehicleId: v.id,
                placa: v.placa,
                registroInterno: v.registroInterno,
                modelo: v.modelo,
                status: v.status,
                fuelLevels: v.fuelLevels,
                partner: partnersMap[pid] || null,
                partnerId: pid,
            };
        });
        res.json(result);
    } catch (error) {
        console.error('Erro ao listar comboios:', error);
        res.status(500).json({ error: 'Erro ao listar comboios.' });
    }
});

// Roda a sincronização (cria partners-espelho ausentes)
router.post('/comboios/sync', adminOnly, async (req, res) => {
    try {
        const result = await syncAllComboioPartners(db);
        if (req.io) req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: `${result.synced}/${result.total} comboios sincronizados.`, ...result });
    } catch (error) {
        console.error('Erro ao sincronizar comboios:', error);
        res.status(500).json({ error: 'Erro ao sincronizar comboios.' });
    }
});

// Reativa o partner-espelho de um comboio específico
router.post('/comboios/:vehicleId/activate', adminOnly, async (req, res) => {
    try {
        const partner = await ensureComboioPartner(db, req.params.vehicleId, { activate: true });
        if (!partner) return res.status(404).json({ error: 'Veículo não encontrado.' });
        if (req.io) req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: 'Partner-comboio ativado.', partner });
    } catch (error) {
        console.error('Erro ao ativar partner-comboio:', error);
        res.status(500).json({ error: 'Erro ao ativar partner-comboio.' });
    }
});

// Desativa (BLOQUEADO) o partner-espelho — preserva histórico
router.post('/comboios/:vehicleId/deactivate', adminOnly, async (req, res) => {
    try {
        await deactivateComboioPartner(db, req.params.vehicleId);
        if (req.io) req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: 'Partner-comboio desativado.' });
    } catch (error) {
        console.error('Erro ao desativar partner-comboio:', error);
        res.status(500).json({ error: 'Erro ao desativar partner-comboio.' });
    }
});

// Atualiza contatos do partner-comboio (telefone, whatsapp, email) — usado
// para o envio automático de ordens via WhatsApp/E-mail (Fase 2.6/3.3).
router.patch('/comboios/:vehicleId/partner', adminOnly, async (req, res) => {
    const allowed = ['telefone', 'whatsapp', 'email', 'contatoResponsavel'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
        if (key in req.body) {
            sets.push(`${key} = ?`);
            params.push(req.body[key] || null);
        }
    }
    if (sets.length === 0) return res.json({ message: 'Nada para atualizar.' });
    try {
        const partnerId = buildComboioPartnerId(req.params.vehicleId);
        // Garante que o partner existe antes de patchear
        await ensureComboioPartner(db, req.params.vehicleId);
        params.push(partnerId);
        await db.query(`UPDATE partners SET ${sets.join(', ')} WHERE id = ?`, params);
        if (req.io) req.io.emit('server:sync', { targets: ['partners'] });
        res.json({ message: 'Contatos do comboio atualizados.' });
    } catch (error) {
        console.error('Erro ao atualizar contatos do comboio:', error);
        res.status(500).json({ error: 'Erro ao atualizar contatos do comboio.' });
    }
});

// Histórico de períodos por obra de um comboio (Fase 2.6)
// Retorna períodos + totais agregados (litros entrada/saída/drenagem) por período.
router.get('/comboios/:vehicleId/periodos', adminOnly, async (req, res) => {
    try {
        const { vehicleId } = req.params;
        const periods = await listComboioPeriods(db, vehicleId);
        if (periods.length === 0) return res.json([]);

        const ids = periods.map(p => p.id);
        const placeholders = ids.map(() => '?').join(',');
        const [agg] = await db.query(
            `SELECT obra_periodo_id, type, SUM(liters) AS total_litros, COUNT(*) AS qtd
             FROM comboio_transactions
             WHERE obra_periodo_id IN (${placeholders})
             GROUP BY obra_periodo_id, type`,
            ids
        );
        const aggMap = {};
        for (const r of agg) {
            const id = r.obra_periodo_id;
            if (!aggMap[id]) aggMap[id] = { entrada: 0, saida: 0, drenagem: 0, qtdTotal: 0 };
            aggMap[id][r.type] = Number(r.total_litros) || 0;
            aggMap[id].qtdTotal += Number(r.qtd) || 0;
        }
        res.json(periods.map(p => ({
            ...p,
            totais: aggMap[p.id] || { entrada: 0, saida: 0, drenagem: 0, qtdTotal: 0 },
        })));
    } catch (error) {
        console.error('Erro ao listar períodos do comboio:', error);
        res.status(500).json({ error: 'Erro ao listar períodos do comboio.' });
    }
});

// ─── LOG DE ERROS DE SOLICITAÇÃO DE ABASTECIMENTO (APP) ───────────────────────

router.get('/solicitacao-erros', adminOnly, async (req, res) => {
    try {
        const { from, to, usuario_id, limit } = req.query;
        const conds = [];
        const params = [];
        if (from)        { conds.push('created_at >= ?');   params.push(from); }
        if (to)          { conds.push('created_at <= ?');   params.push(to + ' 23:59:59'); }
        if (usuario_id)  { conds.push('usuario_id = ?');    params.push(usuario_id); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const max = Math.min(parseInt(limit, 10) || 500, 2000);
        const [rows] = await db.query(
            `SELECT * FROM solicitacao_erros_log ${where} ORDER BY created_at DESC LIMIT ${max}`,
            params
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar log de erros:', error);
        res.status(500).json({ error: 'Erro ao listar log de erros de solicitação.' });
    }
});

router.get('/solicitacao-erros/resumo', adminOnly, async (req, res) => {
    try {
        const [porUsuario] = await db.query(`
            SELECT usuario_id, usuario_nome, COUNT(*) AS total,
                   MAX(created_at) AS ultimo_erro,
                   SUM(tipo_erro = 'regressao')       AS qtd_regressao,
                   SUM(tipo_erro = 'salto_excessivo') AS qtd_salto,
                   SUM(tipo_erro = 'duplicado')       AS qtd_duplicado,
                   SUM(tipo_erro = 'orcamento')       AS qtd_orcamento
            FROM solicitacao_erros_log
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
            GROUP BY usuario_id, usuario_nome
            ORDER BY total DESC
        `);
        res.json({ porUsuario });
    } catch (error) {
        console.error('Erro ao gerar resumo de erros:', error);
        res.status(500).json({ error: 'Erro ao gerar resumo.' });
    }
});

// ─── SESSÕES ATIVAS (stub) ────────────────────────────────────────────────────

router.get('/sessions', adminOnly, async (req, res) => {
    res.json([]);
});

router.delete('/sessions/:id', adminOnly, async (req, res) => {
    res.json({ message: 'Sessão encerrada.' });
});

// ─── BACKUP & EXPORTAÇÃO ──────────────────────────────────────────────────────

const EXPORT_TABLES = {
    vehicles:   'SELECT * FROM vehicles',
    obras:      'SELECT * FROM obras',
    employees:  'SELECT * FROM employees',
    refuelings: 'SELECT * FROM refuelings',
    revisions:  'SELECT * FROM revisions',
    fines:      'SELECT * FROM fines',
    tires:      'SELECT * FROM tires',
    orders:     'SELECT * FROM orders',
};

router.get('/export/:module', adminOnly, async (req, res) => {
    const { module } = req.params;
    const query = EXPORT_TABLES[module];
    if (!query) return res.status(404).json({ error: 'Módulo de exportação não encontrado.' });
    try {
        const [rows] = await db.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao exportar dados:', error);
        res.status(500).json({ error: 'Erro ao exportar dados: ' + error.message });
    }
});

// ─── TESTE WHATSAPP ───────────────────────────────────────────────────────────

router.post('/teste-whatsapp', async (req, res) => {
    try {
        const numeroTeste = req.body.numero;
        const mensagem = '🚜 *Teste Frotas MAK (v2.0)* 🚜\n\nSe você recebeu esta mensagem, acabamos de dar mais um passo em direção à otimização, agora o sistema de Frotas MAK envia automáticamente mensagens pelo Whatsapp';
        const resultado = await whatsappService.enviarMensagem(numeroTeste, mensagem);
        res.status(200).json({ sucesso: true, mensagem: 'Comando de envio disparado!', detalhes: resultado });
    } catch (error) {
        console.error(error);
        res.status(500).json({ sucesso: false, erro: 'Falha na comunicação com a Evolution API.' });
    }
});

// ─── NOTIFICAÇÕES — Destinos por evento (Fase 3.1) ───────────────────────────
// Lista todos os destinos cadastrados (opcionalmente filtrado por event_type).
router.get('/notification-targets', adminOnly, async (req, res) => {
    try {
        const { event_type } = req.query;
        const conds = [];
        const params = [];
        if (event_type) { conds.push('event_type = ?'); params.push(event_type); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const [rows] = await db.query(
            `SELECT id, event_type, channel, target_type, target_value, label, active, created_at
             FROM notification_targets
             ${where}
             ORDER BY event_type ASC, channel ASC, created_at ASC`,
            params
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar notification_targets:', error);
        res.status(500).json({ error: 'Erro ao listar destinos de notificação.' });
    }
});

router.post('/notification-targets', adminOnly, async (req, res) => {
    try {
        const { event_type, channel, target_type, target_value, label, active } = req.body || {};
        if (!event_type || !channel || !target_type || !target_value) {
            return res.status(400).json({ error: 'event_type, channel, target_type e target_value são obrigatórios.' });
        }
        const validChannels = ['whatsapp', 'email'];
        const validTargetTypes = ['user', 'role', 'employee', 'phone', 'email_address'];
        if (!validChannels.includes(channel)) return res.status(400).json({ error: 'channel inválido.' });
        if (!validTargetTypes.includes(target_type)) return res.status(400).json({ error: 'target_type inválido.' });

        const id = uuidv4();
        await db.query(
            `INSERT INTO notification_targets (id, event_type, channel, target_type, target_value, label, active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, event_type, channel, target_type, String(target_value).trim(), label || null, active === 0 || active === false ? 0 : 1]
        );
        res.status(201).json({ id, message: 'Destino criado.' });
    } catch (error) {
        console.error('Erro ao criar notification_target:', error);
        res.status(500).json({ error: 'Erro ao criar destino de notificação.' });
    }
});

router.put('/notification-targets/:id', adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const allowed = ['event_type', 'channel', 'target_type', 'target_value', 'label', 'active'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                sets.push(`${key} = ?`);
                params.push(key === 'active' ? (req.body[key] ? 1 : 0) : req.body[key]);
            }
        }
        if (sets.length === 0) return res.json({ message: 'Nada para atualizar.' });
        params.push(id);
        const [result] = await db.query(`UPDATE notification_targets SET ${sets.join(', ')} WHERE id = ?`, params);
        if (!result.affectedRows) return res.status(404).json({ error: 'Destino não encontrado.' });
        res.json({ message: 'Destino atualizado.' });
    } catch (error) {
        console.error('Erro ao atualizar notification_target:', error);
        res.status(500).json({ error: 'Erro ao atualizar destino de notificação.' });
    }
});

router.delete('/notification-targets/:id', adminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query('DELETE FROM notification_targets WHERE id = ?', [id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Destino não encontrado.' });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao excluir notification_target:', error);
        res.status(500).json({ error: 'Erro ao excluir destino de notificação.' });
    }
});

module.exports = router;
