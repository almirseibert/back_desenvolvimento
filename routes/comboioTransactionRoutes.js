// routes/comboioTransactionRoutes.js
const express = require('express');
const router = express.Router();
const comboioController = require('../controllers/comboioTransactionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', comboioController.getAllComboioTransactions);
router.get('/:id', comboioController.getComboioTransactionById);
router.delete('/:id', comboioController.deleteTransaction);
// Nova rota de atualização
router.put('/:id', comboioController.updateTransaction);

// Novas rotas para transações do comboio
router.post('/entrada', comboioController.createEntradaTransaction);
router.post('/saida', comboioController.createSaidaTransaction);
router.post('/drenagem', comboioController.createDrenagemTransaction);

module.exports = router;