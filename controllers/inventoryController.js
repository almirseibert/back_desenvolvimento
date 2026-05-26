// ============================================================================
// controllers/inventoryController.js
// Gerenciamento completo do módulo de Estoque/Almoxarifado
// ============================================================================

const db = require('../database');
const crypto = require('crypto');
const whatsappService = require('../services/whatsappService');

// --- Função Auxiliar Segura de JSON ---
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

// ============================================================================
// CATEGORIAS
// ============================================================================

const getAllCategories = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT id, name, description, icon, color, isActive, createdAt, updatedAt
            FROM inventory_categories
            WHERE isActive = TRUE
            ORDER BY name ASC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar categorias:', error);
        res.status(500).json({ error: 'Erro ao buscar categorias' });
    }
};

const createCategory = async (req, res) => {
    const { name, description, icon, color } = req.body;
    try {
        const id = crypto.randomUUID();
        await db.execute(
            `INSERT INTO inventory_categories (id, name, description, icon, color) VALUES (?, ?, ?, ?, ?)`,
            [id, name, description || null, icon || null, color || 'blue-500']
        );
        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.status(201).json({ id, name });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Categoria já existe' });
        }
        console.error('Erro ao criar categoria:', error);
        res.status(500).json({ error: 'Erro ao criar categoria' });
    }
};

const updateCategory = async (req, res) => {
    const { id } = req.params;
    const { name, description, icon, color } = req.body;
    try {
        await db.execute(
            `UPDATE inventory_categories SET name=?, description=?, icon=?, color=?, updatedAt=NOW() WHERE id=?`,
            [name, description || null, icon || null, color || 'blue-500', id]
        );
        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.json({ message: 'Categoria atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar categoria:', error);
        res.status(500).json({ error: 'Erro ao atualizar categoria' });
    }
};

const deleteCategory = async (req, res) => {
    const { id } = req.params;
    try {
        // Verificar se há itens na categoria
        const [items] = await db.execute(
            `SELECT COUNT(*) as count FROM inventory_items WHERE categoryId = ? AND isActive = TRUE`,
            [id]
        );
        if (items[0].count > 0) {
            return res.status(400).json({ error: 'Não é possível deletar categoria com itens ativos' });
        }
        await db.execute(`UPDATE inventory_categories SET isActive = FALSE WHERE id = ?`, [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.json({ message: 'Categoria desativada com sucesso' });
    } catch (error) {
        console.error('Erro ao deletar categoria:', error);
        res.status(500).json({ error: 'Erro ao deletar categoria' });
    }
};

// ============================================================================
// ITENS DE ESTOQUE
// ============================================================================

const getAllItems = async (req, res) => {
    const { categoryId, search, showLowStock = false } = req.query;
    try {
        let query = `
            SELECT i.id, i.sku, i.eaN, i.internalCode, i.name, i.description,
                   i.categoryId, c.name as categoryName, c.color as categoryColor,
                   i.quantity, i.minQuantity, i.maxQuantity, i.unitPrice,
                   i.lastCostPrice, i.unit, i.isActive, i.createdAt, i.updatedAt,
                   (i.quantity * i.unitPrice) as totalValue
            FROM inventory_items i
            LEFT JOIN inventory_categories c ON i.categoryId = c.id
            WHERE i.isActive = TRUE
        `;
        let params = [];

        if (categoryId) {
            query += ` AND i.categoryId = ?`;
            params.push(categoryId);
        }

        if (search) {
            query += ` AND (i.name LIKE ? OR i.sku LIKE ? OR i.eaN LIKE ? OR i.internalCode LIKE ?)`;
            const searchParam = `%${search}%`;
            params.push(searchParam, searchParam, searchParam, searchParam);
        }

        if (showLowStock === 'true') {
            query += ` AND i.quantity <= i.minQuantity`;
        }

        query += ` ORDER BY i.name ASC`;

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar itens:', error);
        res.status(500).json({ error: 'Erro ao buscar itens' });
    }
};

const getItemById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.execute(`
            SELECT i.*, c.name as categoryName, c.color as categoryColor
            FROM inventory_items i
            LEFT JOIN inventory_categories c ON i.categoryId = c.id
            WHERE i.id = ?
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }

        // Buscar referências
        const [references] = await db.execute(`
            SELECT ir.id, ir.referenceItemId, i.sku, i.name, ir.type, ir.notes, ir.priority
            FROM inventory_item_references ir
            LEFT JOIN inventory_items i ON ir.referenceItemId = i.id
            WHERE ir.itemId = ? AND ir.isActive = TRUE
            ORDER BY ir.priority ASC
        `, [id]);

        // Buscar histórico de movimentação recente
        const [movements] = await db.execute(`
            SELECT id, type, quantity, reason, unitPrice, createdBy, createdAt
            FROM inventory_movements
            WHERE itemId = ?
            ORDER BY createdAt DESC
            LIMIT 10
        `, [id]);

        const item = rows[0];
        item.references = references;
        item.movements = movements;

        res.json(item);
    } catch (error) {
        console.error('Erro ao buscar item:', error);
        res.status(500).json({ error: 'Erro ao buscar item' });
    }
};

const createItem = async (req, res) => {
    const { sku, eaN, internalCode, name, description, categoryId, quantity = 0, minQuantity = 5, maxQuantity, unitPrice = 0, unit = 'unidade' } = req.body;
    const userEmail = req.body.userEmail || 'sistema';

    try {
        // Validar SKU único
        const [existing] = await db.execute(`SELECT id FROM inventory_items WHERE sku = ?`, [sku]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'SKU já existe' });
        }

        const id = crypto.randomUUID();
        await db.execute(`
            INSERT INTO inventory_items (
                id, sku, eaN, internalCode, name, description, categoryId,
                quantity, minQuantity, maxQuantity, unitPrice, unit, createdBy
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, sku, eaN || null, internalCode || null, name, description || null, categoryId || null, quantity, minQuantity, maxQuantity ?? null, unitPrice, unit, userEmail]);

        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.status(201).json({ id, sku, name });
    } catch (error) {
        console.error('Erro ao criar item:', error);
        res.status(500).json({ error: 'Erro ao criar item' });
    }
};

const updateItem = async (req, res) => {
    const { id } = req.params;
    const { name, description, categoryId, minQuantity, maxQuantity, unitPrice, unit } = req.body;
    const userEmail = req.body.userEmail || 'sistema';

    try {
        await db.execute(`
            UPDATE inventory_items
            SET name=?, description=?, categoryId=?, minQuantity=?, maxQuantity=?,
                unitPrice=?, unit=?, updatedBy=?, updatedAt=NOW()
            WHERE id=?
        `, [name, description || null, categoryId || null, minQuantity, maxQuantity ?? null, unitPrice, unit, userEmail, id]);

        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.json({ message: 'Item atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar item:', error);
        res.status(500).json({ error: 'Erro ao atualizar item' });
    }
};

const deactivateItem = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(`UPDATE inventory_items SET isActive = FALSE WHERE id = ?`, [id]);
        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.json({ message: 'Item desativado com sucesso' });
    } catch (error) {
        console.error('Erro ao desativar item:', error);
        res.status(500).json({ error: 'Erro ao desativar item' });
    }
};

// ============================================================================
// REFERÊNCIAS/EQUIVALÊNCIAS
// ============================================================================

const addItemReference = async (req, res) => {
    const { itemId, referenceItemId, type, notes, priority = 0 } = req.body;
    try {
        const id = crypto.randomUUID();
        await db.execute(`
            INSERT INTO inventory_item_references (id, itemId, referenceItemId, type, notes, priority)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [id, itemId, referenceItemId, type, notes || null, priority]);

        res.status(201).json({ id, message: 'Referência adicionada com sucesso' });
    } catch (error) {
        console.error('Erro ao adicionar referência:', error);
        res.status(500).json({ error: 'Erro ao adicionar referência' });
    }
};

const removeItemReference = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute(`UPDATE inventory_item_references SET isActive = FALSE WHERE id = ?`, [id]);
        res.json({ message: 'Referência removida com sucesso' });
    } catch (error) {
        console.error('Erro ao remover referência:', error);
        res.status(500).json({ error: 'Erro ao remover referência' });
    }
};

// ============================================================================
// MOVIMENTAÇÕES DE ESTOQUE
// ============================================================================

const recordMovement = async (req, res) => {
    const { itemId, type, quantity, reason, reference, unitPrice } = req.body;
    const userEmail = req.body.userEmail || 'sistema';
    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        // Verificar item e travar a linha para atualização atômica
        const [[item]] = await conn.execute(
            `SELECT id, quantity FROM inventory_items WHERE id = ? AND isActive = TRUE FOR UPDATE`,
            [itemId]
        );
        if (!item) {
            await conn.rollback();
            return res.status(404).json({ error: 'Item não encontrado' });
        }

        const delta = parseInt(quantity);
        const newQuantity = Math.max(0, item.quantity + delta);

        // Registrar movimento
        const id = crypto.randomUUID();
        await conn.execute(
            `INSERT INTO inventory_movements (id, itemId, type, quantity, reason, reference, unitPrice, createdBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, itemId, type, delta, reason || null, reference || null, unitPrice || null, userEmail]
        );

        // Atualizar quantidade e último preço de custo (se entrada com preço)
        if (unitPrice && (type === 'entrada' || type === 'devolucao')) {
            await conn.execute(
                `UPDATE inventory_items SET quantity = ?, lastCostPrice = ?, updatedBy = ?, updatedAt = NOW() WHERE id = ?`,
                [newQuantity, parseFloat(unitPrice), userEmail, itemId]
            );
        } else {
            await conn.execute(
                `UPDATE inventory_items SET quantity = ?, updatedBy = ?, updatedAt = NOW() WHERE id = ?`,
                [newQuantity, userEmail, itemId]
            );
        }

        await conn.commit();
        if (req.io) req.io.emit('server:sync', { targets: ['inventory'] });
        res.status(201).json({ id, message: 'Movimento registrado com sucesso', newQuantity });
    } catch (error) {
        await conn.rollback();
        console.error('Erro ao registrar movimento:', error);
        res.status(500).json({ error: 'Erro ao registrar movimento' });
    } finally {
        conn.release();
    }
};

const getItemMovements = async (req, res) => {
    const { itemId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const safeLimit = Math.max(1, parseInt(limit, 10) || 20);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    try {
        const [movements] = await db.execute(`
            SELECT id, type, quantity, reason, reference, unitPrice, createdBy, createdAt
            FROM inventory_movements
            WHERE itemId = ?
            ORDER BY createdAt DESC
            LIMIT ? OFFSET ?
        `, [itemId, safeLimit, safeOffset]);

        const [[{ total }]] = await db.execute(`
            SELECT COUNT(*) as total FROM inventory_movements WHERE itemId = ?
        `, [itemId]);

        res.json({ movements, total: Number(total) || 0 });
    } catch (error) {
        console.error('Erro ao buscar movimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar movimentos' });
    }
};

// ============================================================================
// DASHBOARD / RELATÓRIOS
// ============================================================================

const getInventorySummary = async (req, res) => {
    try {
        // Total de itens
        const [[{ totalItems }]] = await db.execute(
            `SELECT COUNT(*) as totalItems FROM inventory_items WHERE isActive = TRUE`
        );

        // Valor total em estoque
        const [[{ totalValue }]] = await db.execute(
            `SELECT SUM(quantity * unitPrice) as totalValue FROM inventory_items WHERE isActive = TRUE`
        );

        // Itens em falta (estoque zerado)
        const [[{ outOfStock }]] = await db.execute(
            `SELECT COUNT(*) as outOfStock FROM inventory_items WHERE quantity = 0 AND isActive = TRUE`
        );

        // Itens em estoque crítico
        const [[{ lowStock }]] = await db.execute(
            `SELECT COUNT(*) as lowStock FROM inventory_items 
             WHERE quantity > 0 AND quantity <= minQuantity AND isActive = TRUE`
        );
        
        res.json({
            totalItems: Number(totalItems) || 0,
            totalValue: Number(totalValue) || 0,
            outOfStock: Number(outOfStock) || 0,
            lowStock: Number(lowStock) || 0,
            criticalItems: (Number(outOfStock) || 0) + (Number(lowStock) || 0)
        });
    } catch (error) {
        console.error('Erro ao buscar resumo:', error);
        res.status(500).json({ error: 'Erro ao buscar resumo' });
    }
};

const getLowStockItems = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT id, sku, name, quantity, minQuantity, unitPrice,
                   (minQuantity - quantity) as deficit,
                   categoryName
            FROM (
                SELECT i.id, i.sku, i.name, i.quantity, i.minQuantity, i.unitPrice, c.name as categoryName
                FROM inventory_items i
                LEFT JOIN inventory_categories c ON i.categoryId = c.id
                WHERE i.quantity <= i.minQuantity AND i.isActive = TRUE
            ) t
            ORDER BY deficit DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar itens críticos:', error);
        res.status(500).json({ error: 'Erro ao buscar itens críticos' });
    }
};

const getValueByCategory = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT c.id, c.name, c.color,
                   COUNT(i.id) as totalItems,
                   SUM(i.quantity) as totalQuantity,
                   SUM(i.quantity * i.unitPrice) as totalValue
            FROM inventory_categories c
            LEFT JOIN inventory_items i ON c.id = i.categoryId AND i.isActive = TRUE
            GROUP BY c.id, c.name, c.color
            ORDER BY totalValue DESC
        `);
        
        const formattedRows = rows.map(r => ({
            ...r,
            totalItems: Number(r.totalItems) || 0,
            totalQuantity: Number(r.totalQuantity) || 0,
            totalValue: Number(r.totalValue) || 0
        }));
        
        res.json(formattedRows);
    } catch (error) {
        console.error('Erro ao buscar valor por categoria:', error);
        res.status(500).json({ error: 'Erro ao buscar valor por categoria' });
    }
};

// ============================================================================
// ALERTAS
// ============================================================================

const getActiveAlerts = async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT ia.id, ia.itemId, ia.type, ia.severity, ia.title, ia.message,
                   ia.suggestedAction, ia.createdAt, i.sku, i.name
            FROM inventory_alerts ia
            LEFT JOIN inventory_items i ON ia.itemId = i.id
            WHERE ia.isActive = TRUE
            ORDER BY 
                CASE ia.severity
                    WHEN 'critical' THEN 1
                    WHEN 'error' THEN 2
                    WHEN 'warning' THEN 3
                    ELSE 4
                END,
                ia.createdAt DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar alertas:', error);
        res.status(500).json({ error: 'Erro ao buscar alertas' });
    }
};

const acknowledgeAlert = async (req, res) => {
    const { id } = req.params;
    const userEmail = req.body.userEmail || 'sistema';

    try {
        await db.execute(
            `UPDATE inventory_alerts
             SET isActive = FALSE, acknowledgedAt = NOW(), acknowledgedBy = ?
             WHERE id = ?`,
            [userEmail, id]
        );
        res.json({ message: 'Alerta reconhecido com sucesso' });
    } catch (error) {
        console.error('Erro ao reconhecer alerta:', error);
        res.status(500).json({ error: 'Erro ao reconhecer alerta' });
    }
};

module.exports = {
    getAllCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    getAllItems,
    getItemById,
    createItem,
    updateItem,
    deactivateItem,
    addItemReference,
    removeItemReference,
    recordMovement,
    getItemMovements,
    getInventorySummary,
    getLowStockItems,
    getValueByCategory,
    getActiveAlerts,
    acknowledgeAlert,
};