// controllers/refuelingController.js
const db = require('../database');
const crypto = require('crypto');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { recalcFuelAverage } = require('../utils/recalcFuelAverage');
const { notifyComboioEntrada } = require('../services/orderNotifier');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');

// ─── Auto-envio da ordem ao posto (WhatsApp/E-mail) ─────────────────────────
// Reusa o orderNotifier (mesmo pipeline da entrada de comboio): gera o PDF
// uma vez, anexa por e-mail e manda link pelo WhatsApp — respeitando os
// checkboxes envia_por_whatsapp / envia_por_email do partner. Fire-and-forget.
const dispatchOrderToPartner = async (refuelingId) => {
    try {
        const [[r]] = await db.execute(
            `SELECT r.id, r.authNumber, r.data, r.partnerId, r.partnerName,
                    r.fuelType, r.litrosLiberados, r.isFillUp, r.pricePerLiter, r.invoiceNumber,
                    r.needsArla, r.isFillUpArla, r.litrosLiberadosArla,
                    r.outros, r.outrosValor,
                    r.odometro, r.horimetro, r.createdBy,
                    v.registroInterno, v.placa, v.marca, v.modelo, v.tipo,
                    e.nome AS employeeName,
                    o.nome AS obraName
             FROM refuelings r
             LEFT JOIN vehicles  v ON v.id = r.vehicleId
             LEFT JOIN employees e ON e.id = r.employeeId
             LEFT JOIN obras     o ON o.id = r.obraId
             WHERE r.id = ?`, [refuelingId]
        );
        if (!r) return;

        const isKm = r.odometro && parseFloat(r.odometro) > 0;
        const readingLabel = isKm ? 'Odômetro' : (r.horimetro ? 'Horímetro' : 'Leitura');
        const readingValue = isKm ? `${r.odometro} Km` : (r.horimetro ? `${r.horimetro} h` : 'N/A');

        let issuer = 'Sistema MAK Frotas';
        try {
            const cb = typeof r.createdBy === 'string' ? JSON.parse(r.createdBy) : r.createdBy;
            issuer = cb?.userEmail || cb?.name || cb?.email || issuer;
        } catch (_) {}

        notifyComboioEntrada({
            partnerId: r.partnerId,
            comboioVehicleId: null,
            order: {
                tipo: 'abastecimento',
                authNumber: r.authNumber,
                date: r.data,
                fuelType: r.fuelType,
                liters: r.litrosLiberados,
                isFillUp: !!r.isFillUp,
                pricePerLiter: r.pricePerLiter,
                invoiceNumber: r.invoiceNumber,
                partnerName: r.partnerName,
                registroInterno: r.registroInterno || '',
                vehicleLabel: `${r.registroInterno || ''} - ${r.placa || ''}`.trim(),
                vehicleModelo: `${r.marca || ''} ${r.modelo || ''}`.trim(),
                employeeName: r.employeeName || '',
                obraName: r.obraName || '',
                readingLabel,
                readingValue,
                needsArla: !!r.needsArla,
                isFillUpArla: !!r.isFillUpArla,
                litrosLiberadosArla: r.litrosLiberadosArla,
                outros: r.outros,
                outrosValor: r.outrosValor,
                issuer,
            },
        }).then(result => {
            console.log(`[orderNotifier] ordem #${r.authNumber}:`, JSON.stringify(result));
        }).catch(err => {
            console.warn(`[orderNotifier] ordem #${r.authNumber} falha geral:`, err.message);
        });
    } catch (e) {
        console.warn('[dispatchOrderToPartner] erro:', e.message);
    }
};

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
        litrosAbastecidosArla: row.litrosAbastecidosArla ? parseFloat(row.litrosAbastecidosArla) : 0,
        pricePerLiter: row.pricePerLiter ? parseFloat(row.pricePerLiter) : 0,
        pricePerLiterArla: row.pricePerLiterArla ? parseFloat(row.pricePerLiterArla) : 0,
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
            (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
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

const checkLeituraBloqueada = async (connection, vehicleId, odometro, horimetro) => {
    if (!vehicleId) return null;
    try {
        const [[v]] = await connection.execute(
            'SELECT tipo, odometro AS odoAtual, horimetro AS horiAtual FROM vehicles WHERE id = ?',
            [vehicleId]
        );
        if (!v) return null;

        const ODO_MAX_JUMP = 1000;
        const HORI_MAX_JUMP = 50;

        const odo = odometro != null ? parseFloat(odometro) : NaN;
        const hori = horimetro != null ? parseFloat(horimetro) : NaN;
        const odoAtual = parseFloat(v.odoAtual || 0);
        const horiAtual = parseFloat(v.horiAtual || 0);

        if (!isNaN(odo) && odoAtual > 0) {
            if (odo < odoAtual)
                return `Odômetro informado (${odo} Km) é inferior ao atual do veículo (${odoAtual} Km).`;
            if (odo - odoAtual > ODO_MAX_JUMP)
                return `Salto de odômetro excessivo: ${odo - odoAtual} Km (máx. ${ODO_MAX_JUMP} Km).`;
        }
        if (!isNaN(hori) && horiAtual > 0) {
            if (hori < horiAtual)
                return `Horímetro informado (${hori} Hr) é inferior ao atual do veículo (${horiAtual} Hr).`;
            if (hori - horiAtual > HORI_MAX_JUMP)
                return `Salto de horímetro excessivo: ${hori - horiAtual} Hr (máx. ${HORI_MAX_JUMP} Hr).`;
        }
        return null;
    } catch {
        return null;
    }
};

const checkOrcamentoBloqueado = async (connection, obraId) => {
    if (!obraId || obraId === 'Patio') return false;
    try {
        const [[obraRow]] = await connection.execute(
            'SELECT valorContrato FROM obras WHERE id = ?', [obraId]
        );
        if (!obraRow || !obraRow.valorContrato || parseFloat(obraRow.valorContrato) <= 0) return false;

        const [[expRow]] = await connection.execute(
            'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE obraId = ? AND category = "Combustível"',
            [obraId]
        );
        const totalGasto = parseFloat(expRow.total || 0);
        const limite = parseFloat(obraRow.valorContrato) * 0.20;
        return totalGasto >= limite;
    } catch {
        return false;
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
            const dateStr = data.date.toString();
            if (dateStr.includes('T')) {
                dataAbastecimento = new Date(dateStr);
            } else {
                // Data sem horário — usa o horário real atual em BRT (GMT-3)
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
                dataAbastecimento = new Date(`${dateStr}T${pad(brt.getHours())}:${pad(brt.getMinutes())}:${pad(brt.getSeconds())}-03:00`);
            }
        }

        // ─── Anti-duplicidade: bloqueia 2ª ordem aberta para o mesmo veículo ──
        // Exceções:
        //  - data em fim-de-semana ou feriado nacional fixo (antecipação legítima
        //    para obras que operam quando o escritório está fechado);
        //  - veículo fictício (vehicles.permiteMultiplosAbastecimentos = 1)
        //    usado para ajuda de custo, gerador, lava-jato etc.
        // FOR UPDATE serializa contra criações concorrentes dentro da transação.
        if (data.vehicleId) {
            const FERIADOS_BR_FIXOS = new Set([
                '01-01', '04-21', '05-01', '09-07',
                '10-12', '11-02', '11-15', '12-25'
            ]);
            const dow = dataAbastecimento.getDay();
            const mmdd = dataAbastecimento.toISOString().slice(5, 10);
            const isWeekendOrHoliday = dow === 0 || dow === 6 || FERIADOS_BR_FIXOS.has(mmdd);

            const [vehicleRows] = await connection.execute(
                'SELECT permiteMultiplosAbastecimentos FROM vehicles WHERE id = ?',
                [data.vehicleId]
            );
            const allowMultiple = vehicleRows.length > 0
                && (vehicleRows[0].permiteMultiplosAbastecimentos == 1 || vehicleRows[0].permiteMultiplosAbastecimentos === true);

            if (!isWeekendOrHoliday && !allowMultiple) {
                const [openRows] = await connection.execute(
                    `SELECT id, authNumber, status
                       FROM refuelings
                      WHERE vehicleId = ?
                        AND status NOT IN ('Concluída','Concluida','Cancelada','Negada','Baixada')
                      LIMIT 1
                      FOR UPDATE`,
                    [data.vehicleId]
                );
                if (openRows.length > 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(409).json({
                        error: `Já existe ordem em aberto Nº ${openRows[0].authNumber} (${openRows[0].status}) para este veículo. Conclua ou cancele antes de emitir outra.`,
                        code: 'DUPLICATE_OPEN_ORDER',
                        openOrderId: openRows[0].id,
                        openOrderAuthNumber: openRows[0].authNumber,
                        openOrderStatus: openRows[0].status
                    });
                }
            }

            // ─── Bloqueio: veículo a >7 dias em obra com operador placeholder ───
            // Quando um veículo é alocado a uma obra sem o operador real definido,
            // entra um placeholder (COLABORADOR, TESTE, MAK SERVIÇOS etc.). Se o
            // operador real não for trocado em até 7 dias, suspende emissão de
            // ordens até que alguém atualize o operador na tela de alocação.
            const [placeholderRows] = await connection.execute(
                `SELECT h.dataEntrada, e.nome AS employeeName
                   FROM obras_historico_veiculos h
                   INNER JOIN employees e ON e.id = h.employeeId
                  WHERE h.veiculoId = ?
                    AND h.dataSaida IS NULL
                    AND e.isPlaceholder = 1
                    AND h.dataEntrada <= DATE_SUB(NOW(), INTERVAL 7 DAY)
                  ORDER BY h.dataEntrada ASC
                  LIMIT 1`,
                [data.vehicleId]
            );
            if (placeholderRows.length > 0) {
                const dias = Math.floor((Date.now() - new Date(placeholderRows[0].dataEntrada).getTime()) / 86400000);
                await connection.rollback();
                connection.release();
                return res.status(409).json({
                    error: `Bloqueado: veículo está há ${dias} dias na obra com operador fictício "${placeholderRows[0].employeeName}". Atualize o operador real antes de emitir ordens.`,
                    code: 'PLACEHOLDER_OPERATOR_BLOCK',
                    placeholderName: placeholderRows[0].employeeName,
                    diasNaObra: dias,
                });
            }
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

        const motivoLeitura = await checkLeituraBloqueada(
            connection, data.vehicleId,
            data.odometro != null ? parseFloat(data.odometro) : null,
            data.horimetro != null ? parseFloat(data.horimetro) : null
        );
        const bloqueadoOrcamento = !motivoLeitura && await checkOrcamentoBloqueado(connection, data.obraId);

        let initialStatus = data.status || 'Aberta';
        if (motivoLeitura) initialStatus = 'BloqueadoLeitura';
        else if (bloqueadoOrcamento) initialStatus = 'BloqueadoOrcamento';

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
            status: initialStatus,
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
            editedBy: motivoLeitura
                ? JSON.stringify({ motivoBloqueio: motivoLeitura })
                : (data.editedBy ? JSON.stringify(data.editedBy) : null),
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

        // Busca tipo do veículo para aplicar regra odômetro/horímetro
        const [[vehicleRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [data.vehicleId]);
        if (vehicleRow) {
            const readingVal = safeNum(data.odometro) || safeNum(data.horimetro);
            if (readingVal) {
                await updateVehicleReading(connection, data.vehicleId, vehicleRow.tipo, readingVal, 'auto');
            }
        }

        if (refuelingData.status === 'Concluída' && refuelingData.obraId && refuelingData.partnerId && refuelingData.fuelType) {
            await updateMonthlyExpense(connection, refuelingData.obraId, refuelingData.partnerId, refuelingData.fuelType, refuelingData.data);
        }

        await connection.commit();
        req.io.emit('server:sync', { targets: ['refuelings', 'vehicles', 'expenses', 'solicitacoes'] });

        // Dispara envio automático ao posto APENAS se a ordem foi efetivamente liberada.
        // Bloqueios (leitura/orçamento) aguardam ação do admin — o envio acontece no liberar.
        if (initialStatus === 'Aberta' || initialStatus === 'Concluída') {
            dispatchOrderToPartner(id);
        }

        let mensagemRetorno = 'Ordem emitida.';
        if (motivoLeitura) {
            mensagemRetorno = `Ordem Nº ${newAuthNumber} salva com bloqueio de leitura: ${motivoLeitura} Aguarde liberação do Administrador ou corrija os dados.`;
        } else if (bloqueadoOrcamento) {
            mensagemRetorno = `Ordem Nº ${newAuthNumber} salva, mas bloqueada por orçamento (≥20% do contrato). Aguarde liberação do Administrador.`;
        }

        res.status(201).json({
            id,
            authNumber: newAuthNumber,
            bloqueadoOrcamento: !!bloqueadoOrcamento,
            bloqueadoLeitura: !!motivoLeitura,
            motivoBloqueioLeitura: motivoLeitura || null,
            message: mensagemRetorno
        });
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

        const readingValUpdate = (updateData.odometro > 0 ? updateData.odometro : null) || (updateData.horimetro > 0 ? updateData.horimetro : null);
        if (readingValUpdate) {
            const [[vRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [oldRefueling.vehicleId]);
            if (vRow) {
                await updateVehicleReading(connection, oldRefueling.vehicleId, vRow.tipo, readingValUpdate, 'auto');
            }
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
        pricePerLiterArla,
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

        const [[vehicle]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [order.vehicleId]);

        const vehicleUpdate = {};
        const readingVal = safeNum(confirmedReading);

        if (readingVal && vehicle) {
            const updatedField = await updateVehicleReading(connection, order.vehicleId, vehicle.tipo, readingVal, 'auto');
            if (updatedField) vehicleUpdate[updatedField] = readingVal;
        }

        const safePrice = safeNum(pricePerLiter, true);
        const safePriceArla = safeNum(pricePerLiterArla, true);

        if (order.partnerId && safePrice > 0 && order.fuelType && updatePartnerPrice === true) {
            const priceQuery = `
                INSERT INTO partner_fuel_prices (partnerId, fuelType, price)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE price = VALUES(price)
            `;
            await connection.execute(priceQuery, [order.partnerId, order.fuelType, safePrice]);

            // Atualiza também o preço do Arla cadastrado para o posto, se informado
            if (order.needsArla && safePriceArla > 0) {
                await connection.execute(priceQuery, [order.partnerId, 'Arla', safePriceArla]);
            }
        }

        const orderUpdate = {
            status: 'Concluída',
            litrosAbastecidos: safeNum(litrosAbastecidos, true),
            litrosAbastecidosArla: safeNum(litrosAbastecidosArla, true),
            pricePerLiter: safePrice,
            pricePerLiterArla: safePriceArla,
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

        // Recalcula médias de consumo após confirmar abastecimento
        try {
            await recalcFuelAverage(connection, order.vehicleId);
        } catch (e) {
            console.warn('[recalcFuelAverage] Falha ao recalcular média:', e.message);
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

const negarOrdemBloqueada = async (req, res) => {
    const { id } = req.params;
    try {
        const [[ordem]] = await db.execute('SELECT id, status FROM refuelings WHERE id = ?', [id]);
        if (!ordem) return res.status(404).json({ error: 'Ordem não encontrada.' });
        if (!['BloqueadoOrcamento', 'BloqueadoLeitura'].includes(ordem.status)) {
            return res.status(400).json({ error: 'Ordem não está bloqueada.' });
        }
        await db.execute('DELETE FROM refuelings WHERE id = ?', [id]);
        req.io.emit('server:sync', { targets: ['refuelings'] });
        res.json({ message: 'Ordem negada e excluída.' });
    } catch (error) {
        console.error('Erro ao negar ordem:', error);
        res.status(500).json({ error: 'Erro ao negar ordem.' });
    }
};

const liberarOrdemBloqueada = async (req, res) => {
    const { id } = req.params;
    const liberadoPor = req.body.liberadoPor || req.user || null;
    try {
        const [[ordem]] = await db.execute('SELECT id, status FROM refuelings WHERE id = ?', [id]);
        if (!ordem) return res.status(404).json({ error: 'Ordem não encontrada.' });
        if (!['BloqueadoOrcamento', 'BloqueadoLeitura'].includes(ordem.status)) {
            return res.status(400).json({ error: 'Ordem não está bloqueada.' });
        }
        await db.execute(
            'UPDATE refuelings SET status = "Aberta", editedBy = ? WHERE id = ?',
            [JSON.stringify({ acao: 'liberacao_orcamento', por: liberadoPor }), id]
        );
        req.io.emit('server:sync', { targets: ['refuelings'] });
        // Após o admin liberar, a ordem agora vai ao posto — dispara envio automático
        dispatchOrderToPartner(id);
        res.json({ message: 'Ordem liberada com sucesso.' });
    } catch (error) {
        console.error('Erro ao liberar ordem:', error);
        res.status(500).json({ error: 'Erro ao liberar ordem.' });
    }
};

module.exports = {
    getAllRefuelings,
    getRefuelingById,
    createRefuelingOrder,
    updateRefuelingOrder,
    confirmRefuelingOrder,
    deleteRefuelingOrder,
    liberarOrdemBloqueada,
    negarOrdemBloqueada,
    upload,
    uploadOrderPdf,
    sendOrderEmail
};