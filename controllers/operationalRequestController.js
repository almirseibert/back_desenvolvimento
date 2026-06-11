// controllers/operationalRequestController.js
// Requisições operacionais: usuários da Central Operacional sugerem ao
// administrador a real obra/operador de um veículo. Não há fluxo de aprovação
// dedicado — o admin apenas visualiza na aba "Requisições" de ADMIN → Frota e
// resolve (marca como resolvida) ou descarta.
const db = require('../database');
const whatsappService = require('../services/whatsappService');
const { sendEmail } = require('../services/emailService');

const TIPOS_VALIDOS = ['mudanca_obra', 'mudanca_operador'];

const listarRequisicoes = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT * FROM operational_requests ORDER BY created_at DESC'
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar requisições operacionais:', error);
        res.status(500).json({ error: 'Erro ao buscar requisições operacionais' });
    }
};

const criarRequisicao = async (req, res) => {
    const {
        tipo,
        veiculo_id,
        veiculo_registro,
        obra_atual_id,
        obra_atual_nome,
        operador_atual_nome,
        valor_sugerido_id,
        valor_sugerido_nome,
        observacao,
    } = req.body;

    if (!TIPOS_VALIDOS.includes(tipo)) {
        return res.status(400).json({ error: 'Tipo de requisição inválido.' });
    }
    if (!veiculo_id) {
        return res.status(400).json({ error: 'Veículo é obrigatório.' });
    }
    if (!valor_sugerido_nome) {
        return res.status(400).json({ error: 'A sugestão (obra ou operador) é obrigatória.' });
    }

    try {
        const [result] = await db.execute(
            `INSERT INTO operational_requests
                (tipo, veiculo_id, veiculo_registro, obra_atual_id, obra_atual_nome,
                 operador_atual_nome, valor_sugerido_id, valor_sugerido_nome, observacao,
                 status, solicitante_id, solicitante_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
            [
                tipo,
                veiculo_id,
                veiculo_registro || null,
                obra_atual_id || null,
                obra_atual_nome || null,
                operador_atual_nome || null,
                valor_sugerido_id || null,
                valor_sugerido_nome,
                observacao || null,
                req.user?.id || null,
                req.user?.email || null,
            ]
        );

        // Atualiza a aba de Requisições em tempo real.
        req.io.emit('server:sync', { targets: ['operationalRequests'] });

        // Pop-up + som para o administrador (mecanismo já existente).
        const label = tipo === 'mudanca_obra' ? 'mudança de obra' : 'mudança de operador';
        req.io.emit('admin:notificacao', {
            tipo: 'requisicao_operacional',
            mensagem: `Nova requisição de ${label} para o equipamento ${veiculo_registro || veiculo_id}.`,
        });

        res.status(201).json({ id: result.insertId });
    } catch (error) {
        console.error('Erro ao criar requisição operacional:', error);
        res.status(500).json({ error: 'Erro ao criar requisição operacional' });
    }
};

// Marca como resolvida (status) — não aplica a mudança automaticamente.
const resolverRequisicao = async (req, res) => {
    try {
        await db.execute(
            "UPDATE operational_requests SET status = 'resolvida' WHERE id = ?",
            [req.params.id]
        );
        req.io.emit('server:sync', { targets: ['operationalRequests'] });
        res.json({ ok: true });
    } catch (error) {
        console.error('Erro ao resolver requisição operacional:', error);
        res.status(500).json({ error: 'Erro ao resolver requisição operacional' });
    }
};

const deletarRequisicao = async (req, res) => {
    try {
        await db.execute('DELETE FROM operational_requests WHERE id = ?', [req.params.id]);
        req.io.emit('server:sync', { targets: ['operationalRequests'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar requisição operacional:', error);
        res.status(500).json({ error: 'Erro ao deletar requisição operacional' });
    }
};

// Cobrança educada das horas pendentes diretamente ao operador (WhatsApp/email).
// Não persiste estado — apenas dispara a mensagem nos canais disponíveis.
const solicitarRelatorio = async (req, res) => {
    const { employeeId, veiculo_registro, obra_nome, dias } = req.body;

    if (!employeeId) {
        return res.status(400).json({ error: 'Operador não informado.' });
    }

    try {
        const [rows] = await db.query(
            'SELECT nome, contato, email FROM employees WHERE id = ?',
            [employeeId]
        );
        const emp = rows[0];
        if (!emp) {
            return res.status(404).json({ error: 'Operador não encontrado.' });
        }
        if (!emp.contato && !emp.email) {
            return res.status(422).json({ error: 'Operador sem WhatsApp ou e-mail cadastrado.' });
        }

        const primeiroNome = (emp.nome || '').trim().split(/\s+/)[0] || 'colega';
        const diasNum = dias != null ? parseInt(dias, 10) : null;
        const diasTexto = (diasNum != null && !isNaN(diasNum))
            ? String(diasNum)
            : 'vários';

        // Carrega o template editável pelo admin (Comunicação > Templates).
        // Fallback: usa o conteúdo padrão caso o registro tenha sido removido.
        const TEMPLATE_NAME = 'Cobrança de Horas — Operacional';
        const FALLBACK =
            'Olá, {{primeiro_nome}}! Tudo bem? 😊\n\n' +
            'Notamos que o lançamento de horas do equipamento *{{veiculo}}* na obra *{{obra}}* está pendente há *{{dias}} dia(s)*.\n\n' +
            'Por gentileza, poderia regularizar o registro das horas assim que possível? Isso nos ajuda a manter o controle da obra em dia.\n\n' +
            'Agradecemos a colaboração! 🙏\n— Equipe MAK Serviços';
        const [tplRows] = await db.query('SELECT content FROM message_templates WHERE name = ? LIMIT 1', [TEMPLATE_NAME]);
        const conteudo = tplRows[0]?.content || FALLBACK;

        const vars = {
            responsavel: emp.nome || '',
            primeiro_nome: primeiroNome,
            veiculo: veiculo_registro || 'o equipamento',
            obra: obra_nome || 'a obra',
            dias: diasTexto,
        };
        const mensagem = conteudo.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] != null ? String(vars[k]) : `{{${k}}}`);

        const enviados = [];
        const erros = [];

        if (emp.contato) {
            try {
                await whatsappService.enviarMensagem(emp.contato, emp.nome, 'cobranca_horas', mensagem);
                enviados.push('whatsapp');
            } catch (e) { erros.push({ canal: 'whatsapp', erro: e.message }); }
        }
        if (emp.email) {
            try {
                await sendEmail({
                    to: emp.email,
                    subject: 'Lançamento de horas pendente — MAK Serviços',
                    text: mensagem.replace(/\*/g, ''),
                    html: mensagem.replace(/\*(.*?)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>'),
                });
                enviados.push('email');
            } catch (e) { erros.push({ canal: 'email', erro: e.message }); }
        }

        if (enviados.length === 0) {
            return res.status(502).json({ error: 'Falha ao enviar a cobrança nos canais disponíveis.', erros });
        }

        res.json({ ok: true, enviados, erros });
    } catch (error) {
        console.error('Erro ao solicitar relatório de horas:', error);
        res.status(500).json({ error: 'Erro ao solicitar relatório de horas' });
    }
};

module.exports = {
    listarRequisicoes,
    criarRequisicao,
    resolverRequisicao,
    deletarRequisicao,
    solicitarRelatorio,
};
