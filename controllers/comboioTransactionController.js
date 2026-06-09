// controllers/comboioTransactionController.js
const db = require('../database');
const { createOrUpdateWeeklyFuelExpense } = require('./expenseController');
const crypto = require('crypto');
const { updateVehicleReading } = require('../utils/updateVehicleReading');
const { ensureComboioPartner, buildComboioPartnerId } = require('../utils/ensureComboioPartner');
const { notifyComboioEntrada } = require('../services/orderNotifier');
const { ensureOpenComboioPeriod, getActivePeriodId } = require('../utils/comboioPeriodo');

// --- HELPERS DE SANITIZAÇÃO ---
const sanitize = (value) => (value === undefined || value === 'undefined' || value === '' ? null : value);

// Converte data enviada pelo frontend para Date no horário real BRT (GMT-3).
// Se a string já tiver 'T' (inclui horário), usa diretamente; caso contrário
// combina a data fornecida com o horário atual em BRT para evitar o efeito
// UTC→BRT que transformava datas em "09:00:00".
const parseDateBRT = (d) => {
    if (!d) return new Date();
    const s = String(d);
    if (s.includes('T')) return new Date(s);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    return new Date(`${s}T${pad(brt.getHours())}:${pad(brt.getMinutes())}:${pad(brt.getSeconds())}-03:00`);
};

const sanitizeNumber = (value) => {
    if (value === undefined || value === null || value === '' || isNaN(value)) return null;
    return parseFloat(value);
};

// --- HELPER: Checar Duplicidade de NF ---
const checkDuplicateNF = async (connection, partnerId, invoiceNumber, excludeId = null) => {
    if (!invoiceNumber) return;
    const nfStr = invoiceNumber.toString().trim();
    if (!nfStr) return;

    let query = 'SELECT id FROM comboio_transactions WHERE partnerId = ? AND invoiceNumber = ?';
    const params = [partnerId, nfStr];

    if (excludeId) {
        query += ' AND id != ?';
        params.push(excludeId);
    }

    const [rows] = await connection.execute(query, params);
    if (rows.length > 0) {
        throw new Error(`A Nota Fiscal ${nfStr} já consta lançada para este posto.`);
    }
};

// --- HELPER: Obter Preço Médio do Combustível ---
const getAverageFuelPrice = async (connection, fuelType) => {
    const [rows] = await connection.execute(
        'SELECT AVG(price) as avgPrice FROM partner_fuel_prices WHERE fuelType = ? AND price > 0',
        [fuelType]
    );
    return rows[0].avgPrice ? parseFloat(rows[0].avgPrice) : 0;
};

// --- HELPER: Atualização de Despesas Mensais (Posto) ---
const updateMonthlyExpense = async (connection, obraId, partnerId, fuelType, dateInput) => {
    // Agora permite obraId NULO para contabilizar o Estoque do Comboio para o Posto
    if (!partnerId || !fuelType || !dateInput) return;

    if (obraId) {
        const [obraCheck] = await connection.execute('SELECT id FROM obras WHERE id = ?', [obraId]);
        if (obraCheck.length === 0) return; 
    }

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59);

    const [partners] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partners[0]?.razaoSocial || 'Posto Desconhecido';

    // Soma refuelings do posto (separando por obra ou pegando os que não tem obra = comboio)
    let querySum = `
        SELECT SUM(
            (COALESCE(litrosAbastecidos, 0) * COALESCE(pricePerLiter, 0)) +
            (COALESCE(litrosAbastecidosArla, 0) * COALESCE(pricePerLiterArla, 0)) +
            COALESCE(outrosValor, 0)
        ) as total
        FROM refuelings
        WHERE partnerId = ?
          AND fuelType = ?
          AND data BETWEEN ? AND ?
    `;
    const paramsSum = [partnerId, fuelType, startDate, endDate];

    if (obraId) {
        querySum += ' AND obraId = ?';
        paramsSum.push(obraId);
    } else {
        querySum += ' AND obraId IS NULL';
    }

    const [rows] = await connection.execute(querySum, paramsSum);
    const totalAmount = rows[0]?.total || 0;

    const monthName = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const description = `Combustível: ${fuelType} - ${partnerName} (${monthName})`;

    let queryExisting = 'SELECT id FROM expenses WHERE description = ?';
    let paramsExisting = [description];
    if (obraId) {
        queryExisting += ' AND obraId = ?';
        paramsExisting.push(obraId);
    } else {
        queryExisting += ' AND obraId IS NULL';
    }

    const [existingExpense] = await connection.execute(queryExisting, paramsExisting);

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
                [newId, obraId || null, description, totalAmount, startDate, partnerName, fuelType]
            );
        }
    } else {
        if (existingExpense.length > 0) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [existingExpense[0].id]);
        }
    }
};

// --- HELPER: Gerenciar Despesa na Saída (Custo interno para Obra) ---
const manageSaidaExpense = async ({ connection, obraId, date, fuelType, valueChange, transactionId }) => {
    if (!obraId || !fuelType || valueChange === 0) return;

    const expenseDate = new Date(date);
    const month = expenseDate.getMonth() + 1;
    const year = expenseDate.getFullYear();
    const referenceDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);
    
    const mesExtenso = expenseDate.toLocaleString('pt-BR', { month: 'long' });
    const capitalizedMonth = mesExtenso.charAt(0).toUpperCase() + mesExtenso.slice(1);
    const formattedFuel = fuelType === 'dieselS10' ? 'Diesel S10' : (fuelType === 'dieselComum' ? 'Diesel Comum' : fuelType);
    const description = `Combustível: ${formattedFuel} - #Comboio (${capitalizedMonth}/${year})`;

    const [existingExpenses] = await connection.execute(
        `SELECT id, amount FROM expenses 
         WHERE obraId = ? 
         AND description = ? 
         AND category = 'Combustível'
         LIMIT 1`,
        [obraId, description]
    );

    if (existingExpenses.length > 0) {
        const expense = existingExpenses[0];
        const newAmount = parseFloat(expense.amount) + valueChange;
        
        if (Math.abs(newAmount) < 0.01) {
            await connection.execute('DELETE FROM expenses WHERE id = ?', [expense.id]);
        } else {
            await connection.execute('UPDATE expenses SET amount = ? WHERE id = ?', [newAmount, expense.id]);
        }
    } else if (valueChange > 0) {
        const newId = crypto.randomUUID();
        // Correção: Removida a coluna expenseType para evitar erro de banco de dados
        await connection.execute(
            `INSERT INTO expenses (id, obraId, description, amount, category, createdAt, weekStartDate, fuelType, partnerName) 
             VALUES (?, ?, ?, ?, 'Combustível', ?, ?, ?, 'Comboio Interno')`,
            [newId, obraId, description, valueChange, new Date(), referenceDate, fuelType]
        );
    }
};

// --- HELPER: Atualizar Odômetro/Horímetro do Veículo (usando utility compartilhada) ---
const updateVehicleReadingLocal = async (connection, vehicleId, readings) => {
    if (!vehicleId) return;
    const [[vRow]] = await connection.execute('SELECT tipo FROM vehicles WHERE id = ?', [vehicleId]);
    if (!vRow) return;

    const valOdo = sanitizeNumber(readings.odometro);
    const valHor = sanitizeNumber(readings.horimetro);
    const readingVal = (valOdo && valOdo > 0) ? valOdo : (valHor && valHor > 0 ? valHor : null);
    if (readingVal) {
        await updateVehicleReading(connection, vehicleId, vRow.tipo, readingVal, 'auto');
    }
};

// --- HELPER: Obtém ou cria período ativo do comboio na obra ---
const getOrCreateActivePeriod = async (connection, comboioVehicleId, obraId) => {
    if (!comboioVehicleId || !obraId) return null;

    const [[activePeriod]] = await connection.execute(
        'SELECT id, obra_id FROM comboio_periodos_obra WHERE comboio_id = ? AND ativo = 1',
        [comboioVehicleId]
    );

    if (activePeriod) {
        if (activePeriod.obra_id === obraId) return activePeriod.id;
        // Obra mudou — fecha período atual
        await connection.execute(
            'UPDATE comboio_periodos_obra SET data_fim = NOW(), ativo = 0 WHERE id = ?',
            [activePeriod.id]
        );
    }

    const newId = crypto.randomUUID();
    await connection.execute(
        'INSERT INTO comboio_periodos_obra (id, comboio_id, obra_id, data_inicio) VALUES (?, ?, ?, NOW())',
        [newId, comboioVehicleId, obraId]
    );
    return newId;
};

// --- HELPER: Cria ordem C/S para entrada de combustível no comboio ---
const createOrderForEntrada = async (connection, { partnerId, partnerName, comboioVehicleId, obraId, safeLiters, fuelType, price, valorTotal, invoiceNumber, createdBy, date }) => {
    const [counterRows] = await connection.execute(
        'SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE'
    );
    const newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;
    await connection.execute(
        'INSERT INTO counters (name, lastNumber) VALUES ("purchaseOrderCounter", ?) ON DUPLICATE KEY UPDATE lastNumber = ?',
        [newOrderNumber, newOrderNumber]
    );

    const fuelLabel = fuelType === 'dieselS10' ? 'Diesel S10' : fuelType === 'dieselComum' ? 'Diesel Comum' : fuelType;
    const items = JSON.stringify([{
        descricao: `Combustível: ${fuelLabel}`,
        quantidade: safeLiters,
        unidade: 'L',
        valorUnitario: price,
        total: valorTotal
    }]);

    const orderId = crypto.randomUUID();
    await connection.execute(
        `INSERT INTO orders (id, orderNumber, date, supplierId, supplier, vehicleId, obraId, totalValue, status, invoiceNumber, items, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Concluída', ?, ?, ?)`,
        [orderId, newOrderNumber, new Date(date), partnerId, partnerName, comboioVehicleId, obraId || null, valorTotal, invoiceNumber || null, items, JSON.stringify(createdBy || {})]
    );
    return { orderId, orderNumber: newOrderNumber };
};

// --- HELPER: Notifica posto após entrada (WhatsApp / Email) ---
const notifyPartnerEntrada = async (partnerId, partnerName, orderNumber, safeLiters, fuelType, date) => {
    try {
        const [[partner]] = await db.execute(
            'SELECT whatsapp, email, envia_por_whatsapp, envia_por_email FROM partners WHERE id = ?',
            [partnerId]
        );
        if (!partner) return;

        const fuelLabel = fuelType === 'dieselS10' ? 'Diesel S10' : fuelType === 'dieselComum' ? 'Diesel Comum' : fuelType;
        const dateStr = new Date(date).toLocaleDateString('pt-BR');
        const msg = `*Entrada de Combustível — Comboio*\nOrdem nº ${orderNumber}\nCombustível: ${fuelLabel}\nLitros: ${safeLiters}\nData: ${dateStr}`;

        if (partner.envia_por_whatsapp && partner.whatsapp) {
            await whatsappService.enviarMensagem(partner.whatsapp, partnerName, 'Entrada Comboio', msg);
        }
        if (partner.envia_por_email && partner.email) {
            const transporter = nodemailer.createTransport({
                host: process.env.EMAIL_HOST || 'smtp.gmail.com',
                port: process.env.EMAIL_PORT || 587,
                secure: false,
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
                tls: { rejectUnauthorized: false }
            });
            await transporter.sendMail({ from: process.env.EMAIL_USER, to: partner.email, subject: `Entrada Comboio — Ordem nº ${orderNumber}`, text: msg });
        }
    } catch (err) {
        console.warn('[comboio] notifyPartnerEntrada:', err.message);
    }
};

// --- CRUD ---

const getAllComboioTransactions = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions ORDER BY date DESC');
        res.json(rows);
    } catch (error) {
        console.error('Erro GET transactions:', error);
        res.status(500).json({ error: 'Erro ao buscar dados.' });
    }
};

const getComboioTransactionById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM comboio_transactions WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Transação não encontrada' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar transação' });
    }
};

// --- CRIAR ENTRADA (Abastecimento do Comboio no Posto) ---
const createEntradaTransaction = async (req, res) => {
    const { 
        comboioVehicleId, partnerId, employeeId, 
        obraId, liters, date, fuelType, createdBy, invoiceNumber, 
        pricePerLiter, updatePartnerPrice 
    } = req.body;

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        if (invoiceNumber) {
            await checkDuplicateNF(connection, partnerId, invoiceNumber);
        }

        let price = sanitizeNumber(pricePerLiter);
        if (!price || price <= 0) {
            const [priceRows] = await connection.execute(
                'SELECT price FROM partner_fuel_prices WHERE partnerId = ? AND fuelType = ?',
                [partnerId, fuelType]
            );
            price = (priceRows.length > 0 && priceRows[0].price) ? parseFloat(priceRows[0].price) : 0;
        }

        if (updatePartnerPrice && price > 0) {
            await connection.execute(
                `INSERT INTO partner_fuel_prices (partnerId, fuelType, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)`, 
                [partnerId, fuelType, price]
            );
        }

        const safeLiters = sanitizeNumber(liters) || 0;
        const valorTotal = safeLiters * price;

        const [partners] = await connection.execute('SELECT razaoSocial FROM partners WHERE id = ?', [partnerId]);
        const partnerName = partners[0]?.razaoSocial || 'Parceiro Desconhecido';

        // Nome do comboio (para a notificação/ordem)
        let comboioLabel = 'Comboio';
        let comboioModelo = '';
        let comboioRegistroInterno = '';
        if (comboioVehicleId) {
            const [vRows] = await connection.execute('SELECT registroInterno, placa, modelo, marca FROM vehicles WHERE id = ?', [comboioVehicleId]);
            if (vRows.length > 0) {
                comboioRegistroInterno = vRows[0].registroInterno || '';
                comboioLabel = `${comboioRegistroInterno} - ${vRows[0].placa || ''}`.trim();
                comboioModelo = `${vRows[0].marca || ''} ${vRows[0].modelo || ''}`.trim();
            }
        }

        // Nome do funcionário (para a ordem)
        let employeeName = '';
        if (employeeId) {
            const [eRows] = await connection.execute('SELECT nome FROM employees WHERE id = ?', [employeeId]);
            if (eRows.length > 0) employeeName = eRows[0].nome;
        }

        let obraName = 'Estoque Comboio';
        
        const refuelingId = crypto.randomUUID();
        const refuelingData = {
            id: refuelingId,
            authNumber: newAuthNumber,
            vehicleId: comboioVehicleId,
            partnerId: partnerId,
            partnerName: partnerName,
            employeeId: employeeId,
            obraId: obraId || null,
            fuelType: fuelType,
            data: parseDateBRT(date),
            status: 'Concluída', 
            isFillUp: 0,
            litrosLiberados: safeLiters,
            litrosAbastecidos: safeLiters,
            pricePerLiter: price,
            createdBy: JSON.stringify(createdBy || {}),
            invoiceNumber: invoiceNumber || null
        };

        const rfFields = Object.keys(refuelingData);
        const rfValues = Object.values(refuelingData);
        const rfPlaceholders = rfFields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO refuelings (${rfFields.join(', ')}) VALUES (${rfPlaceholders})`, rfValues);

        // Fase 2.6 — vincula a transação ao período atual do comboio na obra.
        // Se não há período aberto, garante um (cobre o caso de comboio sem
        // alocação formal de obra — abre um período usando a obra informada).
        let obraPeriodoId = null;
        if (comboioVehicleId && obraId) {
            try {
                const ensured = await ensureOpenComboioPeriod(connection, comboioVehicleId, obraId);
                obraPeriodoId = ensured?.id || null;
            } catch (e) {
                console.warn('[comboioPeriodo entrada]', e.message);
            }
        }

        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            authNumber: newAuthNumber,
            type: 'entrada',
            date: parseDateBRT(date),
            comboioVehicleId: sanitize(comboioVehicleId),
            partnerId: sanitize(partnerId),
            partnerName: sanitize(partnerName),
            obraId: sanitize(obraId),
            obraName: sanitize(obraName),
            obra_periodo_id: obraPeriodoId,
            liters: safeLiters,
            fuelType: sanitize(fuelType),
            valorTotal: sanitizeNumber(valorTotal),
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            employeeId: sanitize(employeeId),
            invoiceNumber: sanitize(invoiceNumber)
        };

        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');

        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );

        // Atualiza a despesa financeira apenas para o Posto (Mesmo se obraId for nulo)
        if (refuelingData.partnerId && refuelingData.fuelType) {
            await updateMonthlyExpense(connection, refuelingData.obraId, refuelingData.partnerId, refuelingData.fuelType, refuelingData.data);
        }

        // Cria ordem C/S para rastreabilidade da entrada
        const { orderNumber } = await createOrderForEntrada(connection, {
            partnerId, partnerName, comboioVehicleId, obraId,
            safeLiters, fuelType, price, valorTotal, invoiceNumber, createdBy, date
        });

        await connection.commit();

        // Notifica posto em background (fora da transação)
        notifyPartnerEntrada(partnerId, partnerName, orderNumber, safeLiters, fuelType, date);

        req.io.emit('server:sync', { targets: ['comboio', 'vehicles', 'refuelings', 'expenses', 'orders'] });

        // ─── Envio automático da ordem ────────────────────────────────────
        // Para o posto fornecedor: respeita partners.envia_por_whatsapp / envia_por_email
        // Para o comboio: envia sempre que houver contato cadastrado (aba Admin → Veículos → Comboios)
        // NÃO bloqueia a resposta — qualquer falha apenas é logada.
        notifyComboioEntrada({
            partnerId,
            comboioVehicleId,
            order: {
                tipo: 'entrada_comboio',
                authNumber: newAuthNumber,
                date: refuelingData.data,
                fuelType,
                liters: safeLiters,
                pricePerLiter: price,
                valorTotal,
                invoiceNumber: invoiceNumber || null,
                partnerName,
                registroInterno: comboioRegistroInterno,
                vehicleLabel: comboioLabel,
                vehicleModelo: comboioModelo,
                employeeName,
                issuer: createdBy?.userEmail || createdBy?.name || 'Sistema',
            },
        }).then(result => {
            console.log('[orderNotifier] entrada comboio:', JSON.stringify(result));
        }).catch(err => {
            console.warn('[orderNotifier] falha geral:', err.message);
        });

        res.status(201).json({ message: 'Entrada registrada.', refuelingOrder: { authNumber: newAuthNumber } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro Entrada:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- CRIAR SAÍDA (Abastecimento de Veículo pelo Comboio) ---
const createSaidaTransaction = async (req, res) => {
    const { 
        comboioVehicleId, receivingVehicleId, 
        odometro, horimetro, 
        liters, date, fuelType, 
        obraId, employeeId, createdBy 
    } = req.body;
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [counterRows] = await connection.execute('SELECT lastNumber FROM counters WHERE name = "refuelingCounter" FOR UPDATE');
        const newAuthNumber = (counterRows[0]?.lastNumber || 0) + 1;
        await connection.execute('UPDATE counters SET lastNumber = ? WHERE name = "refuelingCounter"', [newAuthNumber]);

        const safeLiters = sanitizeNumber(liters) || 0;

        let obraName = 'Obra Desconhecida';
        if (obraId) {
            const [obraRows] = await connection.execute('SELECT nome FROM obras WHERE id = ?', [obraId]);
            obraName = obraRows[0]?.nome || obraId;
        }

        let receivingVehicleName = null;
        if (receivingVehicleId) {
            const [vRows] = await connection.execute('SELECT registroInterno, placa FROM vehicles WHERE id = ?', [receivingVehicleId]);
            if (vRows.length > 0) {
                receivingVehicleName = vRows[0].registroInterno;
            }
        }

        let comboioName = 'Comboio';
        let comboioPartnerId = null;
        if (comboioVehicleId) {
            const [cRows] = await connection.execute('SELECT registroInterno FROM vehicles WHERE id = ?', [comboioVehicleId]);
            if (cRows.length > 0) comboioName = `Comboio ${cRows[0].registroInterno}`;
            // Garante o partner-espelho do comboio e usa seu ID como partnerId do refueling,
            // permitindo que o histórico/médias por posto enxergue o comboio como fornecedor.
            try {
                const partner = await ensureComboioPartner(connection, comboioVehicleId);
                if (partner) {
                    comboioPartnerId = partner.id;
                    if (partner.razaoSocial) comboioName = partner.razaoSocial;
                }
            } catch (e) {
                console.warn('[ensureComboioPartner saida]', e.message);
                comboioPartnerId = buildComboioPartnerId(comboioVehicleId);
            }
        }

        // Lança na Tabela de Refuelings (Para histórico do veículo que recebeu)
        const refuelingId = crypto.randomUUID();
        const refuelingData = {
            id: refuelingId,
            authNumber: newAuthNumber,
            vehicleId: receivingVehicleId,
            partnerId: comboioPartnerId,
            partnerName: comboioName,
            employeeId: employeeId,
            obraId: obraId || null,
            fuelType: fuelType,
            data: new Date(date),
            status: 'Concluída',
            isFillUp: 0,
            litrosLiberados: safeLiters,
            litrosAbastecidos: safeLiters,
            pricePerLiter: 0, // Custo já está no posto
            odometro: sanitizeNumber(odometro),
            horimetro: sanitizeNumber(horimetro),
            createdBy: JSON.stringify(createdBy || {})
        };

        const rfFields = Object.keys(refuelingData);
        const rfValues = Object.values(refuelingData);
        const rfPlaceholders = rfFields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO refuelings (${rfFields.join(', ')}) VALUES (${rfPlaceholders})`, rfValues);

        // Fase 2.6 — período ativo do comboio (independe da obra de destino,
        // sempre pega o período onde o comboio está hoje).
        let saidaPeriodoId = null;
        if (comboioVehicleId) {
            try { saidaPeriodoId = await getActivePeriodId(connection, comboioVehicleId); }
            catch (e) { console.warn('[comboioPeriodo saida]', e.message); }
        }

        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            authNumber: newAuthNumber,
            type: 'saida',
            date: new Date(date),
            comboioVehicleId: sanitize(comboioVehicleId),
            receivingVehicleId: sanitize(receivingVehicleId),
            receivingVehicleName: sanitize(receivingVehicleName),
            partnerId: comboioPartnerId,
            partnerName: comboioName,
            obraId: sanitize(obraId),
            obraName: sanitize(obraName),
            obra_periodo_id: saidaPeriodoId,
            employeeId: sanitize(employeeId),
            liters: safeLiters,
            fuelType: sanitize(fuelType),
            responsibleUserEmail: sanitize(createdBy?.userEmail),
            odometro: sanitizeNumber(odometro),
            horimetro: sanitizeNumber(horimetro)
        };
        
        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');
        
        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );
        
        await updateVehicleReadingLocal(connection, receivingVehicleId, {
            odometro: transactionData.odometro,
            horimetro: transactionData.horimetro
        });

        const avgPrice = await getAverageFuelPrice(connection, fuelType);
        const expenseValue = safeLiters * avgPrice;

        // Lança custo SOMENTE na obra
        if (expenseValue > 0) {
            await manageSaidaExpense({
                connection,
                obraId,
                date: new Date(date),
                fuelType,
                valueChange: expenseValue,
                transactionId: transactionData.id
            });
        }

        // Gerencia período ativo do comboio na obra
        if (obraId) {
            const obraPeriodoId = await getOrCreateActivePeriod(connection, comboioVehicleId, obraId);
            if (obraPeriodoId) {
                await connection.execute(
                    'UPDATE comboio_transactions SET obra_periodo_id = ? WHERE id = ?',
                    [obraPeriodoId, transactionData.id]
                );
            }
        }

        await connection.commit();

        req.io.emit('server:sync', { targets: ['comboio', 'vehicles', 'expenses', 'refuelings'] });

        res.status(201).json({ message: 'Abastecimento registrado.', refuelingOrder: { authNumber: newAuthNumber } });
    } catch (error) {
        await connection.rollback();
        console.error('Erro Saída:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- DRENAGEM ---
const createDrenagemTransaction = async (req, res) => {
    const { comboioVehicleId, drainingVehicleId, liters, date, fuelType, reason, createdBy } = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        let drainingVehicleName = null;
        if (drainingVehicleId) {
            const [vRows] = await connection.execute('SELECT registroInterno FROM vehicles WHERE id = ?', [drainingVehicleId]);
            if (vRows.length > 0) drainingVehicleName = vRows[0].registroInterno;
        }

        const safeLiters = sanitizeNumber(liters) || 0;

        // Fase 2.6 — período ativo do comboio destino
        let drenagemPeriodoId = null;
        if (comboioVehicleId) {
            try { drenagemPeriodoId = await getActivePeriodId(connection, comboioVehicleId); }
            catch (e) { console.warn('[comboioPeriodo drenagem]', e.message); }
        }

        const transactionData = {
            id: req.body.id || crypto.randomUUID(),
            type: 'drenagem',
            date: new Date(date),
            comboioVehicleId: sanitize(comboioVehicleId),
            drainingVehicleId: sanitize(drainingVehicleId),
            drainingVehicleName: sanitize(drainingVehicleName),
            obra_periodo_id: drenagemPeriodoId,
            liters: safeLiters,
            fuelType: sanitize(fuelType),
            reason: sanitize(reason),
            responsibleUserEmail: sanitize(createdBy?.userEmail),
        };

        const fields = Object.keys(transactionData);
        const values = Object.values(transactionData);
        const placeholders = fields.map(() => '?').join(', ');

        await connection.execute(`INSERT INTO comboio_transactions (${fields.join(', ')}) VALUES (${placeholders})`, values);

        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, drainingVehicleId]
        );
        await connection.execute(
            'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
            [`$.${fuelType}`, `$.${fuelType}`, safeLiters, comboioVehicleId]
        );

        await connection.commit();

        req.io.emit('server:sync', { targets: ['comboio', 'vehicles'] });

        res.status(201).json({ message: 'Drenagem registrada.' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
};

// --- DELETE ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [rows] = await connection.execute('SELECT * FROM comboio_transactions WHERE id = ? FOR UPDATE', [id]);
        if (rows.length === 0) {
             await connection.rollback();
             return res.status(404).json({ error: 'Transação não encontrada' });
        }
        const t = rows[0];

        if (t.type === 'entrada') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', 
                [`$.${t.fuelType}`, `$.${t.fuelType}`, t.liters, t.comboioVehicleId]
            );
            
            if (t.partnerId && t.fuelType) {
                await updateMonthlyExpense(connection, t.obraId, t.partnerId, t.fuelType, t.date);
            }

        } else if (t.type === 'saida') {
            await connection.execute(
                'UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', 
                [`$.${t.fuelType}`, `$.${t.fuelType}`, t.liters, t.comboioVehicleId]
            );
            
            const avgPrice = await getAverageFuelPrice(connection, t.fuelType);
            const valueToRevert = t.liters * avgPrice;
            await manageSaidaExpense({
                connection,
                obraId: t.obraId,
                date: t.date,
                fuelType: t.fuelType,
                valueChange: -valueToRevert 
            });
        } else if (t.type === 'drenagem') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${t.fuelType}`, `$.${t.fuelType}`, t.liters, t.drainingVehicleId]);
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${t.fuelType}`, `$.${t.fuelType}`, t.liters, t.comboioVehicleId]);
        }

        await connection.execute('DELETE FROM comboio_transactions WHERE id = ?', [id]);
        await connection.commit();

        req.io.emit('server:sync', { targets: ['comboio', 'vehicles', 'expenses', 'refuelings'] });

        res.status(204).end();
    } catch (error) {
        await connection.rollback();
        console.error('Erro Delete:', error);
        res.status(500).json({ error: 'Erro ao deletar.' });
    } finally {
        connection.release();
    }
};

// --- UPDATE (Completo) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const newData = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [oldRows] = await connection.execute('SELECT * FROM comboio_transactions WHERE id = ?', [id]);
        if (oldRows.length === 0) throw new Error("Transação não encontrada");
        const oldData = oldRows[0];

        if (newData.invoiceNumber && newData.invoiceNumber !== oldData.invoiceNumber) {
            await checkDuplicateNF(connection, newData.partnerId || oldData.partnerId, newData.invoiceNumber, id);
        }

        // --- REVERSÃO ---
        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
        } else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${oldData.fuelType}`, `$.${oldData.fuelType}`, oldData.liters, oldData.comboioVehicleId]);
            
            const avgPriceOld = await getAverageFuelPrice(connection, oldData.fuelType);
            const valueToRevert = oldData.liters * avgPriceOld;
            await manageSaidaExpense({
                connection,
                obraId: oldData.obraId,
                date: oldData.date,
                fuelType: oldData.fuelType,
                valueChange: -valueToRevert
            });
        }

        // --- APLICAÇÃO ---
        const newLiters = sanitizeNumber(newData.liters) || oldData.liters;
        const newFuelType = sanitize(newData.fuelType) || oldData.fuelType;
        const newDate = newData.date ? new Date(newData.date) : oldData.date;
        const newObraId = sanitize(newData.obraId) || oldData.obraId;

        if (oldData.type === 'entrada') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) + ?) WHERE id = ?', [`$.${newFuelType}`, `$.${newFuelType}`, newLiters, oldData.comboioVehicleId]);
        } else if (oldData.type === 'saida') {
            await connection.execute('UPDATE vehicles SET fuelLevels = JSON_SET(fuelLevels, ?, GREATEST(0, COALESCE(JSON_EXTRACT(fuelLevels, ?), 0) - ?)) WHERE id = ?', [`$.${newFuelType}`, `$.${newFuelType}`, newLiters, oldData.comboioVehicleId]);
            
            const avgPriceNew = await getAverageFuelPrice(connection, newFuelType);
            const valueToAdd = newLiters * avgPriceNew;
            await manageSaidaExpense({
                connection,
                obraId: newObraId,
                date: newDate,
                fuelType: newFuelType,
                valueChange: valueToAdd
            });

            if (newData.odometro || newData.horimetro) {
                await updateVehicleReadingLocal(connection, newData.receivingVehicleId || oldData.receivingVehicleId, {
                    odometro: newData.odometro,
                    horimetro: newData.horimetro
                });
            }
        }

        const updateQuery = `
            UPDATE comboio_transactions 
            SET liters = ?, date = ?, fuelType = ?, partnerId = ?, employeeId = ?, obraId = ?, 
                odometro = ?, horimetro = ?, invoiceNumber = ? 
            WHERE id = ?
        `;
        
        await connection.execute(updateQuery, [
            newLiters,
            newDate,
            newFuelType,
            sanitize(newData.partnerId) || oldData.partnerId,
            sanitize(newData.employeeId) || oldData.employeeId,
            newObraId,
            sanitizeNumber(newData.odometro) || oldData.odometro,
            sanitizeNumber(newData.horimetro) || oldData.horimetro,
            sanitize(newData.invoiceNumber) || oldData.invoiceNumber,
            id
        ]);

        await connection.commit();

        req.io.emit('server:sync', { targets: ['comboio', 'vehicles', 'expenses', 'refuelings'] });

        res.json({ message: "Transação atualizada com sucesso" });
    } catch (e) {
        await connection.rollback();
        console.error("Erro Update:", e);
        res.status(500).json({ error: e.message });
    } finally {
        connection.release();
    }
};

module.exports = {
    getAllComboioTransactions,
    getComboioTransactionById,
    deleteTransaction,
    createEntradaTransaction,
    createSaidaTransaction,
    createDrenagemTransaction,
    updateTransaction,
};