const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../public/uploads/solicitacoes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

// --- CORREÇÃO DE SEGURANÇA: FILE FILTER SOLICITAÇÕES ---
const fileFilterApp = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Arquivo inválido. Apenas Imagens e PDF são aceitos.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilterApp,
    limits: { fileSize: 5 * 1024 * 1024 } 
});

// --- HELPERS LOCAIS ---
const safeNum = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
};

const normalizeFuelType = (val) => {
    if (!val) return null;
    const v = val.toString().trim().toUpperCase();
    const map = {
        'DIESEL S10': 'dieselS10',
        'DIESEL S500': 'dieselS500',
        'GASOLINA COMUM': 'gasolinaComum',
        'GASOLINA ADITIVADA': 'gasolinaAditivada',
        'ETANOL': 'etanol',
        'ARLA 32': 'arla32'
    };
    return map[v] || val;
};

// --- FUNÇÕES DO MOTORISTA ---

const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
        const usuarioId = req.user.id;
        
        const { 
            veiculo_id, obra_id, posto_id, funcionario_id, 
            tipo_combustivel, litragem, flag_tanque_cheio, 
            flag_outros, descricao_outros, horimetro, odometro, 
            latitude, longitude, observacao,
            data_abastecimento 
        } = req.body;

        const fotoPainel = req.file ? `/uploads/solicitacoes/${req.file.filename}` : null;
        const tipoCombustivelNormalizado = normalizeFuelType(tipo_combustivel);

        // 1. Validar Veículo
        if (!veiculo_id) throw new Error("ID do veículo não informado.");
        
        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [veiculo_id]);
        if (vehicles.length === 0) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Veículo não encontrado.' });
        }
        const veiculo = vehicles[0];

        // 1.1 Validar se já existe solicitação em aberto para este veículo (Regra de Negócio com CORREÇÃO ANTI-TRAVAMENTO)
        // Ignora solicitações travadas mais antigas que 48 horas (se houve erro sistêmico, o motorista consegue pedir de novo após 2 dias)
        const [duplicates] = await connection.execute(
            `SELECT id FROM solicitacoes_abastecimento 
             WHERE veiculo_id = ? 
             AND status IN ('PENDENTE', 'LIBERADO', 'AGUARDANDO_BAIXA')
             AND data_solicitacao >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`,
            [veiculo_id]
        );

        if (duplicates.length > 0) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                error: 'Já existe uma solicitação em andamento para este veículo. Finalize a anterior antes de abrir uma nova.' 
            });
        }

        // 2. Validar Bloqueio Usuário
        const [users] = await connection.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [usuarioId]);
        if (!users.length || users[0].bloqueado_abastecimento === 1) {
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'USUÁRIO BLOQUEADO. Contate o administrador.' });
        }

        // 3. Validação Leitura (Odômetro/Horímetro)
        let erroValidacao = null;
        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        const antHorimetro = safeNum(veiculo.horimetro);

        if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) erroValidacao = `Odômetro menor que o anterior (${antOdometro} Km).`;
            else if ((novoOdometro - antOdometro) > 1000) erroValidacao = `Salto de Odômetro excessivo.`;
        }
        if (novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) erroValidacao = `Horímetro menor que o anterior (${antHorimetro} h).`;
            else if ((novoHorimetro - antHorimetro) > 50) erroValidacao = `Salto de Horímetro excessivo.`;
        }

        if (erroValidacao) {
            const novasTentativas = users[0].tentativas_falhas_abastecimento + 1;
            const bloquear = novasTentativas >= 3 ? 1 : 0;
            
            await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = ?, bloqueado_abastecimento = ? WHERE id = ?', [novasTentativas, bloquear, usuarioId]);
            await connection.commit();
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: `Erro de Leitura: ${erroValidacao} (Tentativa ${novasTentativas}/3).` });
        }

        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

        // 4. Trava Orçamentária
        const [obras] = await connection.execute('SELECT * FROM obras WHERE id = ?', [obra_id]);
        if (obras.length > 0) {
            const valorContrato = parseFloat(obras[0].valorContrato || 0);
            if (valorContrato > 0) {
                 const [expenses] = await connection.execute("SELECT SUM(amount) as total FROM expenses WHERE obraId = ? AND category = 'Combustível'", [obra_id]);
                 const totalGasto = safeNum(expenses[0].total);
                 const custoEst = (flag_tanque_cheio ? 200 : safeNum(litragem)) * 6.50;
                 if ((totalGasto + custoEst) > (valorContrato * 0.20)) {
                    await connection.rollback();
                    if (req.file) fs.unlinkSync(req.file.path);
                    return res.status(400).json({ error: 'Limite orçamentário (20%) excedido.' });
                 }
            }
        }

        // 5. Preparar Dados
        let obsFinal = observacao || '';
        const isOutros = (flag_outros === '1' || flag_outros === 'true' || flag_outros === true);
        if (isOutros && descricao_outros) {
            obsFinal = `[Item: ${descricao_outros}] ${obsFinal}`;
        }

        const dataEfetiva = data_abastecimento ? data_abastecimento : new Date();
        
        // 6. Inserir
        const [result] = await connection.execute(
            `INSERT INTO solicitacoes_abastecimento 
            (usuario_id, veiculo_id, obra_id, posto_id, funcionario_id, tipo_combustivel, 
            litragem_solicitada, flag_tanque_cheio, flag_outros, 
            horimetro_informado, odometro_informado, foto_painel_path, 
            geo_latitude, geo_longitude, status, alerta_media_consumo, data_solicitacao, observacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', 0, ?, ?)`,
            [
                usuarioId, veiculo_id, obra_id, posto_id || null, funcionario_id || null, 
                tipoCombustivelNormalizado, safeNum(litragem), 
                (flag_tanque_cheio === '1' || flag_tanque_cheio === 'true') ? 1 : 0, 
                isOutros ? 1 : 0, novoHorimetro || null, novoOdometro || null, fotoPainel,
                latitude || null, longitude || null, dataEfetiva, obsFinal
            ]
        );

        await connection.commit();
        
        if (req.io) {
            req.io.emit('server:sync', { targets: ['solicitacoes'] });
            req.io.emit('admin:notificacao', { tipo: 'nova_solicitacao', id: result.insertId });
        }

        res.status(201).json({ message: 'Solicitação enviada!', id: result.insertId });

    } catch (error) {
        await connection.rollback();
        console.error("Erro Criar Solicitacao App:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro no servidor: ' + error.message });
    } finally {
        connection.release();
    }
};

const listarMinhasSolicitacoes = async (req, res) => {
    try {
        const usuarioId = req.user.id;
        
        const query = `
            SELECT s.*, 
                   v.placa, v.registroInterno as veiculo_nome, 
                   o.nome as obra_nome, 
                   p.razaoSocial as posto_nome,
                   u.name as solicitante_nome
            FROM solicitacoes_abastecimento s
            LEFT JOIN vehicles v ON s.veiculo_id = v.id
            LEFT JOIN obras o ON s.obra_id = o.id
            LEFT JOIN partners p ON s.posto_id = p.id
            LEFT JOIN users u ON s.usuario_id = u.id
            WHERE 
                s.usuario_id = ? 
                OR 
                s.obra_id IN (
                    SELECT DISTINCT sub_s.obra_id 
                    FROM solicitacoes_abastecimento sub_s 
                    WHERE sub_s.usuario_id = ?
                )
            ORDER BY s.data_solicitacao DESC LIMIT 50
        `;
        const [rows] = await db.execute(query, [usuarioId, usuarioId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao listar solicitações.' });
    }
};

const enviarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        if (!req.file) return res.status(400).json({ error: 'Foto obrigatória.' });
        const fotoPath = `/uploads/solicitacoes/${req.file.filename}`;
        
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "AGUARDANDO_BAIXA", foto_cupom_path = ? WHERE id = ?', [fotoPath, id]);
        
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante enviado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar comprovante.' });
    }
};

const verificarStatusUsuario = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT bloqueado_abastecimento, tentativas_falhas_abastecimento FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ error: 'Usuário não encontrado' });
    } catch (e) {
        res.status(500).json({ error: 'Erro interno' });
    }
};

module.exports = {
    criarSolicitacao,
    listarMinhasSolicitacoes,
    enviarComprovante,
    verificarStatusUsuario,
    upload 
};