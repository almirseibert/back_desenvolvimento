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
// /saida aceita multipart (fotos da distribuição do operador). O multer ignora
// requisições JSON, então a distribuição feita pelo desktop continua funcionando.
router.post('/saida', comboioController.uploadSaidaFotos, comboioController.createSaidaTransaction);
router.post('/drenagem', comboioController.createDrenagemTransaction);

module.exports = router;