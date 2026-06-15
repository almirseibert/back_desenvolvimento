const db = require('../database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { vehicleGroups } = require('../utils/vehicleRules');

// Exceção da trava de leitura: veículos do grupo "Caminhões de Trecho"
// (Caminhão Prancha / Semirreboques) podem deslocar até 2000 km entre
// abastecidas; os demais mantêm o limite padrão de 1000 km.
const getLimiteSaltoKm = (tipo) =>
    vehicleGroups['Caminhões de Trecho']?.includes(tipo) ? 2000 : 1000;

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

// --- LOG DE ERROS DE SOLICITAÇÃO ---
// Grava num histórico permanente quem errou, quando, em qual campo e por quê.
// Roda em conexão separada para não ser desfeito por rollback da transação principal.
const registrarErro = async ({ usuarioId, usuarioNome, veiculoId, veiculoPlaca, obraId,
                               campoErro, tipoErro, mensagem, valorInformado, valorAnterior }) => {
    try {
        await db.query(
            `INSERT INTO solicitacao_erros_log
             (usuario_id, usuario_nome, veiculo_id, veiculo_placa, obra_id,
              campo_erro, tipo_erro, mensagem, valor_informado, valor_anterior)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                usuarioId, usuarioNome || null, veiculoId || null, veiculoPlaca || null, obraId || null,
                campoErro, tipoErro, mensagem,
                valorInformado != null ? String(valorInformado) : null,
                valorAnterior  != null ? String(valorAnterior)  : null,
            ]
        );
    } catch (e) {
        console.warn('[solicitacao_erros_log] falha ao registrar:', e.message);
    }
};

// --- FUNÇÕES DO MOTORISTA ---

const criarSolicitacao = async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const usuarioId = req.user.id;
        const usuarioNome = req.user.name || req.user.email || null;

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

        // Veículos terceirizados ficam fora da nossa malha de gestão de frota:
        // pulam validações de leitura, orçamento e solicitação duplicada — apenas
        // registramos o consumo para faturamento ao terceiro.
        const isOutsourcedVehicle = veiculo.isOutsourced == 1 || veiculo.isOutsourced === true;

        // 1.1 Validar se já existe solicitação em aberto para este veículo (Regra de Negócio com CORREÇÃO ANTI-TRAVAMENTO)
        // Ignora solicitações travadas mais antigas que 48 horas (se houve erro sistêmico, o motorista consegue pedir de novo após 2 dias)
        const [duplicates] = isOutsourcedVehicle ? [[]] : await connection.execute(
            `SELECT id FROM solicitacoes_abastecimento
             WHERE veiculo_id = ?
             AND status IN ('PENDENTE', 'LIBERADO', 'AGUARDANDO_BAIXA')
             AND data_solicitacao >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`,
            [veiculo_id]
        );

        if (duplicates.length > 0) {
            const msg = 'Já existe uma solicitação em andamento para este veículo. Finalize a anterior antes de abrir uma nova.';
            await connection.rollback();
            if (req.file) fs.unlinkSync(req.file.path);
            await registrarErro({
                usuarioId, usuarioNome, veiculoId: veiculo_id, veiculoPlaca: veiculo.placa, obraId: obra_id,
                campoErro: 'veiculoId', tipoErro: 'duplicado', mensagem: msg,
                valorInformado: duplicates[0].id, valorAnterior: null
            });
            return res.status(400).json({
                error: msg,
                campo: 'veiculoId',
                tipo: 'duplicado'
            });
        }

        // 2. Validação Leitura (Odômetro/Horímetro)
        let erroValidacao = null;
        let erroCampo = null;
        let erroTipo  = null;
        let erroValorInformado = null;
        let erroValorAnterior  = null;

        const novoOdometro = safeNum(odometro);
        const novoHorimetro = safeNum(horimetro);
        const antOdometro = safeNum(veiculo.odometro);
        const antHorimetro = safeNum(veiculo.horimetro);

        const limiteSaltoKm = getLimiteSaltoKm(veiculo.tipo);

        // Terceirizados pulam toda a validação de leitura (gestão é do terceiro).
        if (isOutsourcedVehicle) {
            // não valida odômetro/horímetro
        } else if (novoOdometro > 0) {
            if (novoOdometro < antOdometro) {
                erroValidacao = `Odômetro informado (${novoOdometro} Km) é menor que o atual (${antOdometro} Km).`;
                erroCampo = 'odometro'; erroTipo = 'regressao';
                erroValorInformado = novoOdometro; erroValorAnterior = antOdometro;
            } else if ((novoOdometro - antOdometro) > limiteSaltoKm) {
                erroValidacao = `Salto de Odômetro excessivo: de ${antOdometro} para ${novoOdometro} Km (>${limiteSaltoKm} Km).`;
                erroCampo = 'odometro'; erroTipo = 'salto_excessivo';
                erroValorInformado = novoOdometro; erroValorAnterior = antOdometro;
            }
        }
        if (!erroValidacao && !isOutsourcedVehicle && novoHorimetro > 0) {
            if (novoHorimetro < antHorimetro) {
                erroValidacao = `Horímetro informado (${novoHorimetro} h) é menor que o atual (${antHorimetro} h).`;
                erroCampo = 'horimetro'; erroTipo = 'regressao';
                erroValorInformado = novoHorimetro; erroValorAnterior = antHorimetro;
            } else if ((novoHorimetro - antHorimetro) > 50) {
                erroValidacao = `Salto de Horímetro excessivo: de ${antHorimetro} para ${novoHorimetro} h (>50 h).`;
                erroCampo = 'horimetro'; erroTipo = 'salto_excessivo';
                erroValorInformado = novoHorimetro; erroValorAnterior = antHorimetro;
            }
        }

        if (erroValidacao) {
            // Apenas contabiliza tentativa — NÃO bloqueia mais o usuário.
            // O log permanente permite ao admin entender por que o funcionário está errando.
            await connection.execute(
                'UPDATE users SET tentativas_falhas_abastecimento = tentativas_falhas_abastecimento + 1 WHERE id = ?',
                [usuarioId]
            );
            await connection.commit();
            if (req.file) fs.unlinkSync(req.file.path);
            await registrarErro({
                usuarioId, usuarioNome, veiculoId: veiculo_id, veiculoPlaca: veiculo.placa, obraId: obra_id,
                campoErro: erroCampo, tipoErro: erroTipo, mensagem: erroValidacao,
                valorInformado: erroValorInformado, valorAnterior: erroValorAnterior
            });
            return res.status(400).json({
                error: erroValidacao,
                campo: erroCampo,
                tipo: erroTipo,
                valor_informado: erroValorInformado,
                valor_anterior:  erroValorAnterior
            });
        }

        // 3. Trava Orçamentária (20%): aplicada exclusivamente na emissão da ordem
        // pelo setor de frotas (refuelingController → status 'BloqueadoOrcamento'),
        // liberável em Administração > Frota > Abastecimento. O app do operador não
        // bloqueia mais o envio da solicitação — mantém-se uma única trava de 20%.

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

        // Zera o contador de tentativas falhas após um envio bem-sucedido
        await connection.execute('UPDATE users SET tentativas_falhas_abastecimento = 0 WHERE id = ?', [usuarioId]);

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