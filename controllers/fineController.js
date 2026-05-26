// controllers/fineController.js
const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const whatsappService = require('../services/whatsappService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const cleanOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, 'termo-multa-' + uniqueSuffix + '-' + cleanOriginalName);
    }
});

// --- CORREÇÃO DE SEGURANÇA: FILE FILTER MULTAS ---
const fileFilterFines = (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Arquivo inválido. Apenas PDF ou Imagens (JPEG/PNG/WEBP) são aceitos.'), false);
    }
};

const upload = multer({ 
    storage: storage, 
    fileFilter: fileFilterFines,
    limits: { fileSize: 5 * 1024 * 1024 } 
});


const uploadFinePdf = [
    upload.single('file'),
    (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
            }
            const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
            res.status(200).json({ url: fileUrl });
        } catch (error) {
            console.error('Erro no upload PDF Multa:', error);
            res.status(500).json({ error: 'Falha no upload' });
        }
    }
];

// --- Função Auxiliar para Conversão de JSON ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field; 
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
        return null; 
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'. Valor problemático:`, field);
        return null; 
    }
};

// --- Formatação para Frontend ---
const formatFineForFrontend = (fine) => {
    if (!fine) return null;

    const {
        paymentStatus,
        localInfracao,
        codigoInfracao,
        descontarFuncionario, 
        multaNomeFuncionario, 
        ...rest
    } = fine;

    const newFine = {
        ...rest,
        status: paymentStatus,
        local: localInfracao,
        codigoInfração: codigoInfracao,
        discountFromEmployee: !!fine.discountFromEmployee,
        alreadyInEmployeeName: !!fine.alreadyInEmployeeName
    };

    newFine.vehicleInfo = {
        registroInterno: fine.vehicleRegistroInterno,
        placa: fine.vehiclePlaca
    };
    newFine.employeeInfo = {
        nome: fine.employeeName
    };

    newFine.ultimaAlteracao = parseJsonSafe(fine.ultimaAlteracao, 'ultimaAlteracao');

    delete newFine.vehicleRegistroInterno;
    delete newFine.vehiclePlaca;
    delete newFine.employeeName;

    return newFine;
};

// --- READ: Obter todas as multas ---
const getAllFines = async (req, res) => {
    try {
        const query = `
            SELECT 
                f.*,
                v.registroInterno as vehicleRegistroInterno,
                v.placa as vehiclePlaca,
                e.nome as employeeName
            FROM fines f
            LEFT JOIN vehicles v ON f.vehicleId = v.id
            LEFT JOIN employees e ON f.employeeId = e.id
            ORDER BY f.dataInfração DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows.map(formatFineForFrontend));
    } catch (error) {
        console.error('Erro ao buscar multas:', error);
        res.status(500).json({ error: 'Erro ao buscar multas' });
    }
};

// --- READ: Obter multa por ID ---
const getFineById = async (req, res) => {
    try {
         const query = `
            SELECT 
                f.*,
                v.registroInterno as vehicleRegistroInterno,
                v.placa as vehiclePlaca,
                e.nome as employeeName
            FROM fines f
            LEFT JOIN vehicles v ON f.vehicleId = v.id
            LEFT JOIN employees e ON f.employeeId = e.id
            WHERE f.id = ?
        `;
        const [rows] = await db.execute(query, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Multa não encontrada' });
        }
        res.json(formatFineForFrontend(rows[0]));
    } catch (error) {
        console.error('Erro ao buscar multa:', error);
        res.status(500).json({ error: 'Erro ao buscar multa' });
    }
};

const getInfoObjects = async (vehicleId, employeeId) => {
    let vehicleInfo = null;
    let employeeInfo = null;

    if (vehicleId) {
        const [vRows] = await db.execute('SELECT registroInterno, placa, modelo, marca FROM vehicles WHERE id = ?', [vehicleId]);
        if (vRows.length > 0) vehicleInfo = vRows[0];
    }
    if (employeeId) {
        const [eRows] = await db.execute('SELECT nome, cpf FROM employees WHERE id = ?', [employeeId]);
        if (eRows.length > 0) employeeInfo = eRows[0];
    }
    
    return { vehicleInfo, employeeInfo };
};


// --- CREATE ---
const createFine = async (req, res) => {
    const dataFromFrontend = req.body;
    const newFineId = uuidv4();
    
    try {
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);
        
        let ultimaAlteracao = null;
        if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
        const dataForDB = {
            id: newFineId,
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local,
            codigoInfracao: dataFromFrontend.codigoInfração,
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status,
            discountFromEmployee: dataFromFrontend.discountFromEmployee ? 1 : 0,
            alreadyInEmployeeName: dataFromFrontend.alreadyInEmployeeName ? 1 : 0,
            
            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        const fields = Object.keys(dataForDB);
        const values = Object.values(dataForDB);
        const placeholders = fields.map(() => '?').join(', ');
        const query = `INSERT INTO fines (${fields.join(', ')}) VALUES (${placeholders})`;

        await db.execute(query, values);

        req.io.emit('server:sync', { targets: ['fines'] });
        res.status(201).json({ id: newFineId, ...dataFromFrontend });
    } catch (error) {
        console.error('Erro ao criar multa:', error);
        if (error.sqlMessage) console.error('SQL Error:', error.sqlMessage);
        res.status(500).json({ error: 'Erro ao criar multa' });
    }
};

// --- UPDATE ---
const updateFine = async (req, res) => {
    const { id } = req.params;
    const dataFromFrontend = req.body;

    try {
        const { vehicleInfo, employeeInfo } = await getInfoObjects(dataFromFrontend.vehicleId, dataFromFrontend.employeeId);

         let ultimaAlteracao = null;
         if(req.user) {
             ultimaAlteracao = JSON.stringify({
                userId: req.user.id,
                userEmail: req.user.email,
                timestamp: new Date().toISOString()
            });
        }
        
         const dataForDB = {
            vehicleId: dataFromFrontend.vehicleId,
            employeeId: dataFromFrontend.employeeId,
            dataInfração: dataFromFrontend.dataInfração,
            localInfracao: dataFromFrontend.local,
            codigoInfracao: dataFromFrontend.codigoInfração,
            descricao: dataFromFrontend.descricao,
            valor: dataFromFrontend.valor,
            dataVencimento: dataFromFrontend.dataVencimento,
            paymentStatus: dataFromFrontend.status,
            discountFromEmployee: dataFromFrontend.discountFromEmployee ? 1 : 0,
            alreadyInEmployeeName: dataFromFrontend.alreadyInEmployeeName ? 1 : 0,

            vehicleInfo: vehicleInfo ? JSON.stringify(vehicleInfo) : null,
            employeeInfo: employeeInfo ? JSON.stringify(employeeInfo) : null,
            ultimaAlteracao: ultimaAlteracao
        };

        const fields = Object.keys(dataForDB);
        const values = fields.map(key => dataForDB[key]);
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const query = `UPDATE fines SET ${setClause} WHERE id = ?`;

        await db.execute(query, [...values, id]);

        req.io.emit('server:sync', { targets: ['fines'] });
        res.json({ message: 'Multa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar multa:', error);
        if (error.sqlMessage) console.error('SQL Error:', error.sqlMessage);
        res.status(500).json({ error: 'Erro ao atualizar multa' });
    }
};

// --- DELETE ---
const deleteFine = async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM fines WHERE id = ?', [req.params.id]);
         if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Multa não encontrada.' });
        }
        req.io.emit('server:sync', { targets: ['fines'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar multa:', error);
        res.status(500).json({ error: 'Erro ao deletar multa' });
    }
};

// --- NOTIFY (Envio de Mensagem WhatsApp via API) ---
const notifyEmployee = async (req, res) => {
    const { id } = req.params;
    const { pdfUrl } = req.body;
    
    try {
        // Query corrigida: apenas 'e.contato' (conforme estrutura do DB)
        const query = `
            SELECT 
                f.*, 
                v.placa, 
                v.registroInterno, 
                e.nome as employeeName, 
                e.contato 
            FROM fines f
            LEFT JOIN vehicles v ON f.vehicleId = v.id
            LEFT JOIN employees e ON f.employeeId = e.id
            WHERE f.id = ?
        `;
        const [rows] = await db.execute(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Multa não encontrada' });
        }
        
        const fine = rows[0];
        const rawPhone = fine.contato; 
        
        if (!rawPhone) {
            return res.status(400).json({ error: 'Funcionário selecionado não possui número de contato cadastrado.' });
        }
        
        const firstName = fine.employeeName ? fine.employeeName.split(' ')[0] : 'Colaborador';
        
        // Constrói a mensagem
        const msg = 
`*NOTIFICAÇÃO DE INFRAÇÃO DE TRÂNSITO - FROTAS MAK*

Olá, ${firstName}.
Informamos que recebemos uma notificação de infração de trânsito vinculada a um veículo sob sua responsabilidade. O Termo de Responsabilidade e Ciência segue em anexo a esta mensagem.

*Detalhes da Infração:*
🚗 *Veículo:* ${fine.placa || 'N/A'} (${fine.registroInterno || ''})
📅 *Data:* ${new Date(fine.dataInfração).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
📍 *Local:* ${fine.localInfracao || 'Não informado'}
📝 *Motivo:* ${fine.descricao}
💰 *Valor:* R$ ${parseFloat(fine.valor || 0).toFixed(2).replace('.', ',')}

*Atenção:*
Esta multa será processada pelo RH conforme as políticas da empresa.
Caso tenha dúvidas, divergências sobre a autoria ou não concorde com o desconto, favor entrar em contato com o setor de Frotas/RH *imediatamente*.

${!fine.alreadyInEmployeeName ? '⚠️ *IMPORTANTE:* O Formulário de Indicação de Condutor infrator deve ser assinado e sua CNH entregue ao departamento responsável dentro do prazo legal, caso contrário a empresa poderá sofrer a penalidade de NIC (multa com valor dobrado repassado a você).' : ''}

_Mensagem automática enviada pelo Sistema Frotas MAK_`;

        // Dispara para o WhatsApp via Evolution API
        await whatsappService.enviarMensagem(
            rawPhone, 
            fine.employeeName, 
            'Notificação Multa de Trânsito', 
            msg, 
            pdfUrl
        );
        
        res.json({ message: 'Notificação enviada com sucesso!' });

    } catch (error) {
        console.error('Erro no notifyEmployee:', error);
        res.status(500).json({ error: 'Falha ao processar o envio da notificação via WhatsApp.' });
    }
};

module.exports = {
    getAllFines,
    getFineById,
    createFine,
    updateFine,
    deleteFine,
    notifyEmployee,
    uploadFinePdf
};