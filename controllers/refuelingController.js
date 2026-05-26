// controllers/refuelingController.js
const db = require('../database');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');

// --- CONFIGURAÇÃO NODEMAILER (lazy — criado apenas quando necessário) ---
let _transporter = null;
const getTransporter = () => {
    if (!_transporter) {
        _transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST || 'smtp.gmail.com',
            port: process.env.EMAIL_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
            tls: { rejectUnauthorized: false }
        });
    }
    return _transporter;
};

// --- CONFIGURAÇÃO MULTER ---

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '../public/uploads/orders');
        if (!fs.existsSync(uploadPath)){
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Nome único e seguro para o arquivo
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'order-' + uniqueSuffix + '.pdf');
    }
});

const upload = multer({ storage: storage });

// --- HELPERS ---
const safeNum = (val, returnZero = false) => {
    if (val === null || typeof val === 'undefined' || val === '') {
        return returnZero ? 0 : null;
    }
    const num = parseFloat(val);
    return isNaN(num) ? (returnZero ? 0 : null) : num;
};

const parseJsonSafe = (field) => {
    if (!field) return null;
    if (typeof field === 'object') return field;
    try {
        return JSON.parse(field);
    } catch (e) {
        return null;
    }
};

const parseRefuelingRows = (rows) => {
    return rows.map(row => ({
        ...row,
        createdBy: parseJsonSafe(row.createdBy),
        confirmedBy: parseJsonSafe(row.confirmedBy),
        editedBy: parseJsonSafe(row.editedBy),
        litrosAbastecidos: row.litrosAbastecidos ? parseFloat(row.litrosAbastecidos) : 0,
        pricePerLiter: row.pricePerLiter ? parseFloat(row.pricePerLiter) : 0,
        outrosValor: row.outrosValor ? parseFloat(row.outrosValor) : 0,
        outrosGeraValor: !!row.outrosGeraValor,
        invoiceNumber: row.invoiceNumber || null 
    }));
};

// --- ATUALIZAÇÃO DE DESPESAS MENSAIS ---
const updateMonthlyExpense = async (connection, obraId, partnerId, fuelType, dateInput) => {
    if (!obraId || !partnerId || !fuelType || !dateInput) return;

    const [obraCheck] = await connection.execute('SELECT id FROM obras WHERE id = ?', [obraId]);
    if (obraCheck.length === 0) return; 

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59);

    const [partners] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';

    const querySum = `
        SELECT SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) + 
            COALESCE(outrosValor, 0)
        ) as total
        FROM refuelings
        WHERE obraId = ? 
          AND partnerId = ? 
          AND fuelType = ?
          AND data BETWEEN ? AND ?
          AND status = 'Concluída' -- Importante: Somar apenas concluídas para não duplicar valores pendentes
    `;

    const [rows] = await connection.execute(querySum, [obraId, partnerId, fuelType, startDate, endDate]);
    const totalAmount = rows[0]?.total || 0;

    const monthName = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const description = `Combustível: ${fuelType} - ${partnerName} (${monthName})`;

    const [existingExpense] = await connection.execute(
        'SELECT id FROM expenses WHERE obraId = ? AND description = ?',
        [obraId, description]
    );

    if (totalAmount > 0) {
        if (existingExpense.length > 0) {
            await connection.execute(
                'UPDATE expenses SET amount = ?, weekStartDate = ? WHERE id = ?',
                [totalAmount, startDate, existingExpense[0].id]
            );
        } else {
            const newId = crypto.randomUUID();
            await connection.execute(
                `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, partnerName, fuelType)
                 VALUES (?, ?, ?, ?, 'Combustível', NOW(), ?, ?, ?)`,
                [newId, obraId, description, totalAmount, startDate, partnerName, fuelType]
            );
        }
    } else {
        if (existingExpense.length > 0) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense[0].id]);
        }
    }
};

// --- CONTROLLER DE UPLOAD ---
const uploadOrderPdf = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }
        const fileUrl = `/uploads/orders/${req.file.filename}`;
        // Retorna também o filename para facilitar o envio de email (localizar no disco)
        res.json({ url: fileUrl, filename: req.file.filename });
    } catch (error) {
        console.error('Erro no upload do PDF:', error);
        res.status(500).json({ error: 'Falha ao salvar PDF no servidor.' });
    }
};

// --- NOVO: CONTROLLER DE ENVIO DE EMAIL ---
const sendOrderEmail = async (req, res) => {
    const { orderData, partnerEmail, pdfFilename, pdfUrl } = req.body;

    if (!partnerEmail) {
        return res.status(400).json({ error: 'Email do destinatário não informado.' });
    }

    try {
        // Tenta localizar o arquivo físico para anexo
        // O pdfFilename vem do retorno do uploadOrderPdf
        let filenameToUse = pdfFilename;
        if (!filenameToUse && pdfUrl) {
            filenameToUse = path.basename(pdfUrl);
        }

        const filePath = path.join(__dirname, '../public/uploads/orders', filenameToUse);
        
        let attachments = [];
        if (fs.existsSync(filePath)) {
            attachments.push({
                filename: `Autorizacao_${orderData.authNumber}.pdf`,
                path: filePath
            });
        } else {
            console.warn(`Arquivo PDF não encontrado no disco para anexo: ${filePath}`);
            // Se não achar o arquivo, enviaremos apenas o link no corpo do email
        }

        const mailOptions = {
            from: `"Frotas MAK" <${process.env.EMAIL_USER}>`,
            to: partnerEmail,
            subject: `Autorização de Abastecimento #${orderData.authNumber} - ${orderData.partnerName || 'Frotas MAK'}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2>Autorização de Abastecimento</h2>
                    <p>Olá,</p>
                    <p>Segue em anexo a autorização de abastecimento emitida pelo sistema Frotas MAK.</p>
                    
                    <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <p><strong>Número:</strong> #${orderData.authNumber}</p>
                        <p><strong>Veículo:</strong> ${orderData.vehicleInfo || 'N/A'}</p>
                        <p><strong>Combustível:</strong> ${orderData.fuelType}</p>
                        <p><strong>Quantidade:</strong> ${orderData.isFillUp ? 'COMPLETAR TANQUE' : (orderData.litrosLiberados + ' Litros')}</p>
                        ${orderData.outros ? `<p><strong>Outros/Obs:</strong> ${orderData.outros}</p>` : ''}
                    </div>

                    <p>Por favor, realize o abastecimento conforme autorizado.</p>
                    
                    ${attachments.length === 0 ? `<p><strong>Link para Download:</strong> <a href="${pdfUrl}">${pdfUrl}</a></p>` : ''}
                    
                    <hr/>
                    <small>Este é um e-mail automático. Não responda.</small>
                </div>
            `,
            attachments: attachments
        };

        await getTransporter().sendMail(mailOptions);
        res.json({ message: 'Email enviado com sucesso!' });

    } catch (error) {
        console.error("Erro ao enviar email:", error);
        res.status(500).json({ error: 'Falha ao enviar e-mail: ' + error.message });
    }
};

// --- CRUD ---

const getAllRefuelings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings ORDER BY id DESC');
        res.json(parseRefuelingRows(rows));
    } catch (error) {
        console.error('Erro GET refuelings:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const getRefuelingById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM refuelings WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
        res.json(parseRefuelingRows(rows)[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const createRefuelingOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const id = crypto.randomUUID();
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;

        let dataAbastecimento = new Date();
        if (data.date) {
             const dateStr = data.date.toString().includes('T') ? data.date : `${data.date}T12:00:00`;
             dataAbastecimento = new Date(dateStr);
        }

        let finalPartnerName = data.partnerName;
        if (!finalPartnerName && data.partnerId) {
            const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [data.partnerId]);
            if (pRows.length > 0) {
                finalPartnerName = pRows[0].razaoSocial;
            }
        }

        const createdByData = data.createdBy || {};
        if (data.solicitacaoId) {
            createdByData.linkedSolicitacaoId = data.solicitacaoId;
        }

        const refuelingData = {
            id: id,
            authNumber: newAuthNumber,
            vehicleId: data.vehicleId,
            partnerId: data.partnerId,
            partnerName: finalPartnerName || null,
            employeeId: data.employeeId || null,
            obraId: data.obraId || null, 
            fuelType: data.fuelType || null,
            data: dataAbastecimento,
            status: data.status || 'Aberta',
            isFillUp: data.isFillUp ? 1 : 0,
            needsArla: data.needsArla ? 1 : 0,
            isFillUpArla: data.isFillUpArla ? 1 : 0,
            outrosGeraValor: data.outrosGeraValor ? 1 : 0,
            litrosLiberados: safeNum(data.litrosLiberados, true),
            litrosLiberadosArla: safeNum(data.litrosLiberadosArla, true),
            odometro: safeNum(data.odometro),
            horimetro: safeNum(data.horimetro), 
            outrosValor: safeNum(data.outrosValor, true),
            outros: data.outros || null,
            createdBy: JSON.stringify(createdByData),
            confirmedBy: data.confirmedBy ? JSON.stringify(data.confirmedBy) : null,
            editedBy: data.editedBy ? JSON.stringify(data.editedBy) : null,
            invoiceNumber: data.invoiceNumber || null
        };

        const fields = Object.keys(refuelingData);
        const values = Object.values(refuelingData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO refuelings (${fields.join(', ')}) VALUES (${placeholders})`, values);
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        if (data.solicitacaoId) {
            const userId = data.createdBy && data.createdBy.id ? data.createdBy.id : null;
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "LIBERADO", data_aprovacao = NOW(), aprovado_por_usuario_id = ? WHERE id = ?',
                [userId, data.solicitacaoId]
            );
        }

        const vehicleUpdate = {};
        const newOdometro = safeNum(data.odometro);
        const newHorimetro = safeNum(data.horimetro);

        if (newOdometro > 0) vehicleUpdate.odometro = newOdometro;
        if (newHorimetro > 0) {
            vehicleUpdate.horimetro = newHorimetro;
        }

        if (Object.keys(vehicleUpdate).length > 0) {
            const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
            await connection.execute(
                `UPDATE vehicles SET ${vFields} WHERE id = ?`, 
                [...Object.values(vehicleUpdate), data.vehicleId]
            );
        }

        if (refuelingData.status === 'Concluída' && refuelingData.obraId && refuelingData.partnerId && refuelingData.fuelType) {
            await updateMonthlyExpense(connection, refuelingData.obraId, refuelingData.partnerId, refuelingData.fuelType, refuelingData.data);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['refuelings', 'vehicles', 'expenses', 'solicitacoes'] }); 
        res.status(201).json({ id: id, message: 'Ordem emitida.', authNumber: newAuthNumber });
    } catch (error) {
        await connection.rollback();
        console.error('Erro CREATE:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const updateRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [oldData] = await connection.execute('SELECT * FROM refuelings WHERE id = ?', [id]);
        if (oldData.length === 0) throw new Error('Ordem não encontrada');
        const oldRefueling = oldData[0];

        const updateData = {};
        if (data.date) {
            const dateStr = data.date.toString().replace(' ', 'T');
            updateData.data = new Date(dateStr);
        }
        if (data.editedBy) updateData.editedBy = JSON.stringify(data.editedBy);
        if (data.status) updateData.status = data.status;
        
        if (data.litrosLiberados !== undefined) updateData.litrosLiberados = safeNum(data.litrosLiberados, true);
        if (data.litrosAbastecidos !== undefined) updateData.litrosAbastecidos = safeNum(data.litrosAbastecidos, true);
        if (data.litrosAbastecidosArla !== undefined) updateData.litrosAbastecidosArla = safeNum(data.litrosAbastecidosArla, true);

        if (data.odometro !== undefined) updateData.odometro = safeNum(data.odometro);
        if (data.horimetro !== undefined) updateData.horimetro = safeNum(data.horimetro);

        if (data.outrosValor !== undefined) updateData.outrosValor = safeNum(data.outrosValor, true);
        
        if (data.partnerId !== undefined) {
            updateData.partnerId = data.partnerId;
             const [pRows] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [data.partnerId]);
             if (pRows.length > 0) updateData.partnerName = pRows[0].razaoSocial;
        }

        if (data.obraId !== undefined) updateData.obraId = data.obraId || null;
        if (data.fuelType !== undefined) updateData.fuelType = data.fuelType || null;
        if (data.outrosGeraValor !== undefined) updateData.outrosGeraValor = data.outrosGeraValor ? 1 : 0;
        if (data.outros !== undefined) updateData.outros = data.outros || null;

        if (data.invoiceNumber !== undefined) {
            const newInvoiceNumber = data.invoiceNumber ? data.invoiceNumber.toString().trim() : null;
            if (newInvoiceNumber) {
                const partnerIdToCheck = updateData.partnerId || oldRefueling.partnerId;
                const [duplicateCheck] = await connection.execute(
                    'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? AND id != ?',
                    [partnerIdToCheck, newInvoiceNumber, id]
                );
                if (duplicateCheck.length > 0) {
                    throw new Error(`A Nota Fiscal ${newInvoiceNumber} já está cadastrada para este posto.`);
                }
                updateData.invoiceNumber = newInvoiceNumber;
            } else {
                updateData.invoiceNumber = null;
            }
        }

        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        if (Object.keys(updateData).length > 0) {
            const setClause = Object.keys(updateData).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE refuelings SET ${setClause} WHERE id = ?`, [...Object.values(updateData), id]);
        }

        const vehicleUpdate = {};
        if (updateData.odometro > 0) vehicleUpdate.odometro = updateData.odometro;
        if (updateData.horimetro > 0) {
            vehicleUpdate.horimetro = updateData.horimetro;
        }
        
        if (Object.keys(vehicleUpdate).length > 0) {
             const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
             const vId = oldRefueling.vehicleId;
             await connection.execute(`UPDATE vehicles SET ${vFields} WHERE id = ?`, [...Object.values(vehicleUpdate), vId]);
        }

        const currentObra = updateData.obraId || oldRefueling.obraId;
        const currentPartner = updateData.partnerId || oldRefueling.partnerId;
        const currentFuel = updateData.fuelType || oldRefueling.fuelType;
        const currentDate = updateData.data || oldRefueling.data;

        if (currentObra && currentPartner && currentFuel) {
            await updateMonthlyExpense(connection, currentObra, currentPartner, currentFuel, currentDate);
        }

        if (
            (updateData.obraId && updateData.obraId !== oldRefueling.obraId) ||
            (updateData.partnerId && updateData.partnerId !== oldRefueling.partnerId) ||
            (updateData.fuelType && updateData.fuelType !== oldRefueling.fuelType)
        ) {
            if (oldRefueling.obraId && oldRefueling.partnerId && oldRefueling.fuelType) {
                await updateMonthlyExpense(connection, oldRefueling.obraId, oldRefueling.partnerId, oldRefueling.fuelType, oldRefueling.data);
            }
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['refuelings', 'expenses', 'vehicles'] });
        res.json({ message: 'Ordem atualizada.' });
    } catch (error) {
        await connection.rollback();
        console.error('Erro UPDATE:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

const confirmRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const { 
        litrosAbastecidos, 
        litrosAbastecidosArla, 
        pricePerLiter, 
        confirmedReading, 
        confirmedBy, 
        outrosValor, 
        invoiceNumber, 
        updatePartnerPrice 
    } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [orders] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (orders.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }
        const order = orders[0];

        if (invoiceNumber) {
            const nfStr = invoiceNumber.toString().trim();
            if (nfStr) {
                const [duplicates] = await connection.execute(
                    'SELECT id FROM refuelings WHERE partnerId = ? AND invoiceNumber = ? AND id != ?',
                    [order.partnerId, nfStr, id]
                );
                if (duplicates.length > 0) {
                    throw new Error(`A Nota Fiscal ${nfStr} já consta lançada para este posto.`);
                }
            }
        }

        const [vehicles] = await connection.execute('SELECT * FROM vehicles WHERE id = ?', [order.vehicleId]);
        const vehicle = vehicles[0];
        
        const vehicleUpdate = {};
        const readingVal = safeNum(confirmedReading);

        if (readingVal) {
            // Lógica mais robusta para garantir que Leves/Caminhões de Trecho usem Odômetro,
            // espelhando as regras do Frontend (vehicleRules.js).
            const isLeveOrTrecho = [
                'Automóvel', 'Camionete', 'Utilitários', 'Moto', 
                'Caminhão Prancha', 'Semirreboques'
            ].includes(vehicle.tipo);

            if (isLeveOrTrecho) {
                 vehicleUpdate.odometro = readingVal;
            } else {
                 vehicleUpdate.horimetro = readingVal;
            }
        }

        if (Object.keys(vehicleUpdate).length > 0) {
            const vFields = Object.keys(vehicleUpdate).map(k => `${k} = ?`).join(', ');
            await connection.execute(`UPDATE vehicles SET ${vFields} WHERE id = ?`, [...Object.values(vehicleUpdate), order.vehicleId]);
        }

        const safePrice = safeNum(pricePerLiter, true);
        
        if (order.partnerId && safePrice > 0 && order.fuelType && updatePartnerPrice === true) {
            const priceQuery = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price) 
                VALUES (?, ?, ?) 
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            await connection.execute(priceQuery, [order.partnerId, order.fuelType, safePrice]);
        }

        const orderUpdate = {
            status: 'Concluída',
            litrosAbastecidos: safeNum(litrosAbastecidos, true),
            litrosAbastecidosArla: safeNum(litrosAbastecidosArla, true),
            pricePerLiter: safePrice,
            confirmedBy: JSON.stringify(confirmedBy),
            outrosValor: safeNum(outrosValor, true),
            invoiceNumber: invoiceNumber ? invoiceNumber.toString().trim() : null,
            ...(vehicleUpdate.odometro ? { odometro: vehicleUpdate.odometro } : {}),
            ...(vehicleUpdate.horimetro ? { horimetro: vehicleUpdate.horimetro } : {}),
        };

        const oFields = Object.keys(orderUpdate).map(k => `${k} = ?`).join(', ');
        await connection.execute(`UPDATE refuelings SET ${oFields} WHERE id = ?`, [...Object.values(orderUpdate), id]);

        let linkedSolicitacaoId = null;
        if (order.createdFromSolicitacaoId) linkedSolicitacaoId = order.createdFromSolicitacaoId;
        if (!linkedSolicitacaoId && order.createdBy) {
            try {
                const cbObj = JSON.parse(order.createdBy);
                if (cbObj.linkedSolicitacaoId) linkedSolicitacaoId = cbObj.linkedSolicitacaoId;
            } catch (e) {}
        }

        if (linkedSolicitacaoId) {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "CONCLUIDO", data_baixa = NOW() WHERE id = ?',
                [linkedSolicitacaoId]
            );
        }

        if (order.obraId && order.partnerId && order.fuelType) {
            await updateMonthlyExpense(connection, order.obraId, order.partnerId, order.fuelType, order.data);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['refuelings', 'vehicles', 'expenses', 'partners', 'solicitacoes'] });
        res.json({ message: 'Abastecimento confirmado com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro CONFIRM:', error);
        res.status(500).json({ error: 'Erro ao confirmar: ' + error.message });
    } finally {
        connection.release();
    }
};

const deleteRefuelingOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [rows] = await connection.execute('SELECT * FROM refuelings WHERE id = ? FOR UPDATE', [id]);
        if (rows.length === 0) {
             await connection.rollback();
             return res.status(404).json({ error: 'Ordem não encontrada' });
        }
        const ref = rows[0];

        await connection.execute('DELETE FROM refuelings WHERE id = ?', [id]);

        let linkedSolicitacaoId = null;
        if (ref.createdFromSolicitacaoId) linkedSolicitacaoId = ref.createdFromSolicitacaoId;
        if (!linkedSolicitacaoId && ref.createdBy) {
            try {
                const cbObj = JSON.parse(ref.createdBy);
                if (cbObj.linkedSolicitacaoId) linkedSolicitacaoId = cbObj.linkedSolicitacaoId;
            } catch (e) {}
        }

        if (linkedSolicitacaoId) {
            await connection.execute(
                'UPDATE solicitacoes_abastecimento SET status = "NEGADO", motivo_negativa = "Ordem Excluída Manualmente pelo Gestor (Estorno)" WHERE id = ?',
                [linkedSolicitacaoId]
            );
        }

        if (ref.obraId && ref.partnerId && ref.fuelType) {
            await updateMonthlyExpense(connection, ref.obraId, ref.partnerId, ref.fuelType, ref.data);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['refuelings', 'expenses', 'solicitacoes'] });
        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro DELETE:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllRefuelings,
    getRefuelingById,
    createRefuelingOrder,
    updateRefuelingOrder,
    confirmRefuelingOrder,
    deleteRefuelingOrder,
    upload,          
    uploadOrderPdf,
    sendOrderEmail 
};