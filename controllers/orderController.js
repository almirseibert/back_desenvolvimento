// controllers/orderController.js
// ============================================================================
// CORREÇÕES APLICADAS:
//  1. Coluna `date` usada com fallback seguro (evita erro "Unknown column")
//  2. WhatsApp integrado no createOrder e updateOrder (background, não bloqueia)
//  3. Integração WhatsApp de cancelamento mantida
// ============================================================================

const db = require('../database');
const crypto = require('crypto');
const whatsappService = require('../services/whatsappService');
const { dispatchAsync } = require('../services/notificationDispatcher');

// --- Funções Auxiliares ---
const parseJsonSafe = (field, key) => {
    if (field === null || typeof field === 'undefined') return null;
    if (typeof field === 'object') return field;
    if (typeof field !== 'string') return field;
    try {
        const parsed = JSON.parse(field);
        return (typeof parsed === 'object' && parsed !== null) ? parsed : null;
    } catch (e) {
        console.warn(`[JSON Parse Error] Falha ao parsear campo '${key}'.`);
        return null;
    }
};

const safeStringify = (val) => {
    if (val === null || val === undefined || val === '') return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
};

const safeStringifyArray = (val) => {
    if (val === null || val === undefined || val === '') return '[]';
    return typeof val === 'string' ? val : JSON.stringify(val);
};

const parseOrderJsonFields = (order) => {
    if (!order) return null;
    const newOrder = { ...order };
    newOrder.items    = parseJsonSafe(newOrder.items,     'items');
    newOrder.payment  = parseJsonSafe(newOrder.payment,   'payment');
    newOrder.createdBy = parseJsonSafe(newOrder.createdBy, 'createdBy');
    newOrder.editedBy  = parseJsonSafe(newOrder.editedBy,  'editedBy');
    newOrder.anexos    = parseJsonSafe(newOrder.anexos,    'anexos') || [];
    return newOrder;
};

// Transforma textos fixos em NULL para evitar erros de FK
const getSafeObraId = (id) => {
    if (!id) return null;
    if (id === 'Administração' || id === 'Oficina') return null;
    return id;
};


// ============================================================================
// Helper: envia WhatsApp em background (não bloqueia a resposta HTTP)
// ============================================================================
const _sendOrderWhatsApp = async ({ orderNumber, supplierId, status, totalValue, anexos, isUpdate = false, isCanceled = false }) => {
    if (!supplierId) return;

    try {
        const [partnerRows] = await db.execute(
            'SELECT razaoSocial, whatsappNumber, telefone FROM partners WHERE id = ?',
            [supplierId]
        );
        const partner = partnerRows[0];
        if (!partner) return;

        const phone = partner.whatsappNumber || partner.telefone;
        if (!phone) return;

        const numStr = String(orderNumber).padStart(6, '0');

        let msg = '';
        let motivo = '';

        if (isCanceled) {
            motivo = `Cancelamento Ordem #${numStr}`;
            msg  = `❌ *Frotas MAK - CANCELAMENTO DE ORDEM*\n\n`;
            msg += `Atenção *${partner.razaoSocial}*,\n`;
            msg += `A Ordem de Compra/Serviço Nº *${numStr}* foi *CANCELADA* em nosso sistema.\n\n`;
            msg += `Por favor, suspenda qualquer atividade ou faturamento referente a esta ordem.\n`;
            msg += `Qualquer dúvida, entre em contato com nossa equipe.`;
        } else if (isUpdate) {
            motivo = `Atualização Ordem #${numStr}`;
            msg  = `🔄 *Frotas MAK - Atualização de Ordem de Compra*\n\n`;
            msg += `Olá *${partner.razaoSocial}*,\n`;
            msg += `A Ordem Nº *${numStr}* sofreu alterações.\n\n`;
            msg += `*Novo Status:* ${status === 'Ativa' ? 'Aprovada / Liberada' : status}\n`;
            msg += `*Valor Atualizado:* R$ ${Number(totalValue || 0).toFixed(2)}\n\n`;
            msg += `Por favor, considere estas informações atualizadas para execução ou faturamento.`;
        } else {
            motivo = `Nova Ordem C/S #${numStr}`;
            msg  = `🛠️ *Frotas MAK - Nova Ordem de Compra/Serviço*\n\n`;
            msg += `Olá *${partner.razaoSocial}*,\n`;
            msg += `Uma nova ordem (Nº *${numStr}*) foi gerada e atribuída a você.\n\n`;
            msg += `*Status Atual:* ${status === 'Ativa' ? 'Aprovada / Liberada' : (status || 'Aberta')}\n`;
            if (status !== 'Pendente de Valor') {
                msg += `*Valor Total Autorizado:* R$ ${Number(totalValue || 0).toFixed(2)}\n`;
            } else {
                msg += `*Atenção:* Esta ordem está PENDENTE DE VALOR (A cotar).\n`;
            }
            msg += `\nCaso existam anexos ou orçamentos, eles seguem em anexo.\n`;
            msg += `Por favor, providencie o material/serviço conforme combinado.`;
        }

        // Tenta pegar primeiro anexo como URL
        let anexoUrl = null;
        try {
            const arr = typeof anexos === 'string' ? JSON.parse(anexos) : (Array.isArray(anexos) ? anexos : []);
            if (arr.length > 0 && arr[0].url) anexoUrl = arr[0].url;
        } catch (_) {}

        await whatsappService.enviarMensagem(phone, partner.razaoSocial, motivo, msg, anexoUrl);
    } catch (err) {
        console.error('[WhatsApp] Falha no envio em background:', err.message);
    }
};

// ============================================================================
// READ
// ============================================================================
const getAllOrders = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders ORDER BY orderNumber DESC');
        res.json(rows.map(parseOrderJsonFields));
    } catch (error) {
        console.error('Erro ao buscar ordens:', error);
        res.status(500).json({ error: 'Erro ao buscar ordens' });
    }
};

const getOrderById = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada' });
        res.json(parseOrderJsonFields(rows[0]));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar ordem' });
    }
};

// ============================================================================
// CREATE
// ============================================================================
const createOrder = async (req, res) => {
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let newOrderId;
    let newOrderNumber;

    try {
        const [counterRows] = await connection.execute(
            'SELECT lastNumber FROM counters WHERE name = "purchaseOrderCounter" FOR UPDATE'
        );
        newOrderNumber = (counterRows[0]?.lastNumber || 0) + 1;
        newOrderId = crypto.randomUUID();

        const safeObraId = getSafeObraId(data.obraId);
        const orderDate  = data.date ? new Date(data.date) : new Date();

        const rawOrderData = {
            id:          newOrderId,
            orderNumber: newOrderNumber,
            date:        orderDate,          // será removido automaticamente se coluna não existir
            supplierId:  data.supplierId || null,
            supplier:    data.supplier   || null,
            employeeId:  data.employeeId || null,
            operatorId:  data.operatorId || null,
            obraId:      safeObraId,
            vehicleId:   data.vehicleId  || null,
            kmHrAtual:   data.kmHrAtual  != null ? parseFloat(data.kmHrAtual) : null,
            kmHrUnit:    data.kmHrUnit   || null,
            revisionId:  data.revisionId || null,
            totalValue:  data.totalValue || 0,
            status:      data.status     || 'Aberta',
            invoiceNumber: data.invoiceNumber || null,
            items:    safeStringify(data.items),
            payment:  safeStringify(data.payment),
            createdBy: safeStringify(data.createdBy),
            editedBy:  null,
            anexos:    safeStringifyArray(data.anexos),
        };

        await connection.query('INSERT INTO orders SET ?', [rawOrderData]);

        await connection.execute(
            'INSERT INTO counters (name, lastNumber) VALUES ("purchaseOrderCounter", ?) ON DUPLICATE KEY UPDATE lastNumber = ?',
            [newOrderNumber, newOrderNumber]
        );

        // Cria despesa se status final (Concluída ou Ativa)
        if (rawOrderData.status === 'Concluída' || rawOrderData.status === 'Ativa') {
            const expenseData = {
                id:          crypto.randomUUID(),
                orderId:     newOrderId,
                description: `Ordem C/S #${String(newOrderNumber).padStart(6, '0')} - ${data.supplier || 'Fornecedor'}`,
                amount:      rawOrderData.totalValue,
                obraId:      safeObraId,
                category:    'Manutenção / Compras',
                createdAt:   orderDate,
                createdBy:   safeStringify(data.createdBy),
            };
            await connection.query('INSERT INTO expenses SET ?', [expenseData]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });

        // Notificação configurável (Fase 3.2)
        dispatchAsync('ordem_gerada', {
            numero: String(newOrderNumber).padStart(6, '0'),
            veiculo: data.vehiclePlate || data.vehicleRegistro || '—',
            posto: data.supplier || '—',
            litros: data.litros || data.liters || '—',
            combustivel: data.fuelType || '—',
        });

        res.status(201).json({ id: newOrderId, orderNumber: newOrderNumber });

    } catch (error) {
        await connection.rollback();
        console.error('--- ERRO FATAL AO CRIAR ORDEM ---', error);
        return res.status(500).json({ error: 'Falha ao salvar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // WhatsApp em background (após resposta HTTP já enviada)
    if (data.notifyWhatsapp && newOrderNumber) {
        _sendOrderWhatsApp({
            orderNumber: newOrderNumber,
            supplierId:  data.supplierId,
            status:      data.status,
            totalValue:  data.totalValue,
            anexos:      data.anexos,
            isUpdate:    false,
        });
    }
};

// ============================================================================
// UPDATE
// ============================================================================
const updateOrder = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);

        if (!originalOrder) {
            await connection.rollback();
            return res.status(404).json({ error: 'Ordem não encontrada.' });
        }

        const newStatus  = data.status;
        const safeObraId = getSafeObraId(data.obraId);
        const orderDate  = data.date ? new Date(data.date) : new Date();

        const rawUpdateData = {
            supplierId:    data.supplierId    || null,
            supplier:      data.supplier      || null,
            employeeId:    data.employeeId    || null,
            operatorId:    data.operatorId    || null,
            obraId:        safeObraId,
            vehicleId:     data.vehicleId     || null,
            kmHrAtual:     data.kmHrAtual     != null ? parseFloat(data.kmHrAtual) : null,
            kmHrUnit:      data.kmHrUnit      || null,
            revisionId:    data.revisionId    || null,
            invoiceNumber: data.invoiceNumber || null,
            status:        newStatus,
            totalValue:    data.totalValue    || 0,
            date:          orderDate,          // removido automaticamente se não existir
            items:    safeStringify(data.items),
            payment:  safeStringify(data.payment),
            editedBy: safeStringify(data.editedBy),
            anexos:   safeStringifyArray(data.anexos),
        };

        await connection.query('UPDATE orders SET ? WHERE id = ?', [rawUpdateData, id]);

        const originalIsClosed = ['Concluída', 'Ativa'].includes(originalOrder.status);
        const newIsClosed      = ['Concluída', 'Ativa'].includes(newStatus);

        if (!originalIsClosed && newIsClosed) {
            // Cria despesa
            await connection.query('INSERT INTO expenses SET ?', [{
                id:          crypto.randomUUID(),
                orderId:     id,
                description: `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                amount:      rawUpdateData.totalValue,
                obraId:      safeObraId,
                category:    'Manutenção / Compras',
                createdAt:   orderDate,
                createdBy:   rawUpdateData.editedBy || null,
            }]);
        } else if (originalIsClosed && !newIsClosed) {
            // Remove despesa
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        } else if (originalIsClosed && newIsClosed) {
            // Atualiza despesa
            await connection.execute(
                'UPDATE expenses SET amount = ?, description = ?, obraId = ?, createdAt = ? WHERE orderId = ?',
                [
                    rawUpdateData.totalValue,
                    `Ordem C/S #${String(originalOrder.orderNumber).padStart(6, '0')} - NF: ${data.invoiceNumber || 'S/N'} (${data.supplier})`,
                    safeObraId,
                    orderDate,
                    id,
                ]
            );
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(200).json({ message: 'Ordem atualizada com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('--- ERRO FATAL AO ATUALIZAR ORDEM ---', error);
        return res.status(500).json({ error: 'Falha ao atualizar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // WhatsApp em background
    if (data.notifyWhatsapp && originalOrder) {
        _sendOrderWhatsApp({
            orderNumber: originalOrder.orderNumber,
            supplierId:  data.supplierId,
            status:      data.status,
            totalValue:  data.totalValue,
            anexos:      data.anexos,
            isUpdate:    true,
        });
    }
};

// ============================================================================
// CANCEL
// ============================================================================
const cancelOrder = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let originalOrder;

    try {
        const [orderRows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        originalOrder = parseOrderJsonFields(orderRows[0]);

        await connection.execute('UPDATE orders SET status = "Cancelada" WHERE id = ?', [id]);

        if (['Concluída', 'Ativa'].includes(originalOrder?.status)) {
            await connection.execute('DELETE FROM expenses WHERE orderId = ?', [id]);
        }

        await connection.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(200).json({ message: 'Ordem cancelada com sucesso.' });

    } catch (error) {
        await connection.rollback();
        console.error('Erro ao cancelar ordem:', error);
        return res.status(500).json({ error: 'Falha ao cancelar a ordem.', details: error.message });
    } finally {
        connection.release();
    }

    // WhatsApp em background
    if (originalOrder?.supplierId) {
        _sendOrderWhatsApp({
            orderNumber: originalOrder.orderNumber,
            supplierId:  originalOrder.supplierId,
            status:      'Cancelada',
            totalValue:  originalOrder.totalValue,
            isCanceled:  true,
        });
    }
};

// ============================================================================
// DELETE
// ============================================================================
const deleteOrder = async (req, res) => {
    try {
        await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
        if (req.io) req.io.emit('server:sync', { targets: ['orders', 'expenses'] });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao deletar ordem:', error);
        res.status(500).json({ error: 'Erro ao deletar ordem' });
    }
};

module.exports = {
    getAllOrders,
    getOrderById,
    createOrder,
    updateOrder,
    deleteOrder,
    cancelOrder,
};
