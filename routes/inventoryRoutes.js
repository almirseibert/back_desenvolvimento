// ============================================================================
// routes/inventoryRoutes.js
// Rotas para o módulo de Estoque/Almoxarifado
// ============================================================================

const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const authMiddleware = require('../middlewares/authMiddleware');

// Aplicar autenticação em todas as rotas
router.use(authMiddleware);

// ============================================================================
// CATEGORIAS
// ============================================================================

// GET todas as categorias
router.get('/categories', inventoryController.getAllCategories);

// POST criar nova categoria
router.post('/categories', inventoryController.createCategory);

// PUT atualizar categoria
router.put('/categories/:id', inventoryController.updateCategory);

// DELETE desativar categoria
router.delete('/categories/:id', inventoryController.deleteCategory);

// ============================================================================
// ITENS DE ESTOQUE
// ============================================================================

// GET todos os itens (com filtros opcionais)
// Query params: categoryId, search, showLowStock=true/false
router.get('/items', inventoryController.getAllItems);

// GET item específico com referências e movimentos
router.get('/items/:id', inventoryController.getItemById);

// POST criar novo item
router.post('/items', inventoryController.createItem);

// PUT atualizar item
router.put('/items/:id', inventoryController.updateItem);

// DELETE desativar item
router.delete('/items/:id', inventoryController.deactivateItem);

// ============================================================================
// REFERÊNCIAS/EQUIVALÊNCIAS
// ============================================================================

// POST adicionar referência entre itens
router.post('/items/:itemId/references', inventoryController.addItemReference);

// DELETE remover referência
router.delete('/references/:id', inventoryController.removeItemReference);

// ============================================================================
// MOVIMENTAÇÕES
// ============================================================================

// POST registrar movimento de estoque (entrada, saída, ajuste)
router.post('/movements', inventoryController.recordMovement);

// GET histórico de movimentos de um item
// Query params: limit=20, offset=0
router.get('/items/:itemId/movements', inventoryController.getItemMovements);

// ============================================================================
// DASHBOARD / RELATÓRIOS
// ============================================================================

// GET resumo geral do estoque
router.get('/dashboard/summary', inventoryController.getInventorySummary);

// GET itens com estoque crítico
router.get('/dashboard/low-stock', inventoryController.getLowStockItems);

// GET valor em estoque por categoria
router.get('/dashboard/value-by-category', inventoryController.getValueByCategory);

// ============================================================================
// ALERTAS
// ============================================================================

// GET alertas ativos
router.get('/alerts', inventoryController.getActiveAlerts);

// PUT reconhecer/resolver alerta
router.put('/alerts/:id/acknowledge', inventoryController.acknowledgeAlert);

module.exports = router;
