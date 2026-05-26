const db = require('../database');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// --- CONFIGURAÇÃO MULTER E LIMPEZA (Copiado de refuelingController) ---

// Função para limpar arquivos antigos (> 30 dias)
const cleanupOldFiles = (directory) => {
    fs.readdir(directory, (err, files) => {
        if (err) return console.error("Erro ao ler diretório para limpeza:", err);

        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias

        files.forEach(file => {
            const filePath = path.join(directory, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, (err) => {
                        if (err) console.error(`Erro ao deletar arquivo antigo ${file}:`, err);
                    });
                }
            });
        });
    });
};

const storagePdf = multer.diskStorage({
    destination: (req, file, cb) => {
        // Caminho absoluto para garantir compatibilidade
        const dir = path.join(__dirname, '../public/uploads/orders');
        
        // Garante que a pasta existe
        if (!fs.existsSync(dir)) {
            console.log("Criando diretório de ordens:", dir);
            fs.mkdirSync(dir, { recursive: true });
        }

        // Executa limpeza assíncrona (igual ao refuelingController)
        cleanupOldFiles(dir);

        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // Garante a extensão correta
        const ext = path.extname(file.originalname) || '.pdf'; 
        cb(null, `ordem-${uniqueSuffix}${ext}`);
    }
});

const uploadPdf = multer({ 
    storage: storagePdf,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
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

// --- FUNÇÕES DO GESTOR/ADMIN ---

const listarTodasSolicitacoes = async (req, res) => {
    try {
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
            ORDER BY s.data_solicitacao DESC LIMIT 100
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar todas solicitações.' });
    }
};

const uploadPdfGerado = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }
        
        // CORREÇÃO CRÍTICA AQUI:
        // Antes estava: `/uploads/orders${req.file.filename}` (faltava a barra)
        // Agora está correto: `/uploads/orders/${req.file.filename}`
        const fileUrl = `/uploads/orders/${req.file.filename}`;
        
        console.log("PDF Salvo com sucesso:", fileUrl);
        res.json({ url: fileUrl });
    } catch (error) {
        console.error("Erro no upload do PDF:", error);
        res.status(500).json({ error: 'Falha ao salvar PDF no servidor.' });
    }
};

const avaliarSolicitacao = async (req, res) => {
    const { id } = req.params;
    const { status, motivoNegativa } = req.body; 
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [solicitacao] = await connection.execute('SELECT * FROM solicitacoes_abastecimento WHERE id = ? FOR UPDATE', [id]);
        if (!solicitacao.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const sol = solicitacao[0];

        // --- FLUXO DE REPROVAÇÃO ---
        if (status === 'NEGADO') {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, motivo_negativa = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['NEGADO', motivoNegativa, req.user.id, id]
            );
            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
            return res.json({ message: 'Solicitação negada.' });
        }

        // --- FLUXO DE APROVAÇÃO (GERAR ORDEM) ---
        if (status === 'LIBERADO') {
            const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
            const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
            const newRefuelingId = crypto.randomUUID();

            let partnerName = 'Posto Externo';
            if (sol.posto_id) {
                const [p] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [sol.posto_id]);
                if (p.length > 0) partnerName = p[0].razaoSocial;
            }

            let employeeId = sol.funcionario_id; 
            const combustivelFinal = normalizeFuelType(sol.tipo_combustivel);

            // Criação da Ordem Oficial na tabela Refuelings
            await connection.execute(
                `INSERT INTO refuelings (
                    id, authNumber, vehicleId, partnerId, partnerName, 
                    employeeId, obraId, fuelType, data, status, 
                    isFillUp, needsArla, isFillUpArla, outrosGeraValor,
                    litrosLiberados, litrosLiberadosArla, 
                    odometro, horimetro, 
                    outros, outrosValor,
                    createdBy
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'Aberta', ?, 0, 0, 0, ?, 0, ?, ?, ?, 0, ?)`,
                [
                    newRefuelingId, 
                    newAuthNumber, 
                    sol.veiculo_id, 
                    sol.posto_id || null, 
                    partnerName,
                    employeeId, 
                    sol.obra_id, 
                    combustivelFinal, 
                    sol.flag_tanque_cheio, 
                    safeNum(sol.litragem_solicitada),
                    safeNum(sol.odometro_informado), 
                    safeNum(sol.horimetro_informado),
                    sol.observacao || null, 
                    JSON.stringify({ id: req.user.id, name: req.user.name || 'Gestor' })
                ]
            );

            await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = ?, aprovado_por_usuario_id = ?, data_aprovacao = NOW() WHERE id = ?',
                ['LIBERADO', req.user.id, id]
            );

            await connection.commit();
            if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes', 'refuelings'] });
            return res.json({ message: 'Solicitação liberada! Ordem gerada.', authNumber: newAuthNumber });
        }

    } catch (error) {
        await connection.rollback();
        console.error("Erro Avaliar Admin:", error);
        res.status(500).json({ error: 'Erro ao avaliar: ' + error.message });
    } finally {
        connection.release();
    }
};

const confirmarBaixa = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Baixa confirmada.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao confirmar baixa.' });
    }
};

const rejeitarComprovante = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('UPDATE solicitacoes_abastecimento SET status = "LIBERADO" WHERE id = ?', [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['solicitacoes'] });
        res.json({ message: 'Comprovante rejeitado.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar.' });
    }
};

module.exports = {
    listarTodasSolicitacoes,
    avaliarSolicitacao,
    confirmarBaixa,
    rejeitarComprovante,
    uploadPdfGerado,
    uploadPdf // Exporta o multer configurado
};