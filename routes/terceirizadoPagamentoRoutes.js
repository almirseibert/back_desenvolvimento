// routes/terceirizadoPagamentoRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/terceirizadoPagamentoController');

router.use(authMiddleware);

router.get('/', controller.getTerceirizadoPagamentos);
router.post('/', controller.createTerceirizadoPagamento);
router.put('/:id', controller.updateTerceirizadoPagamento);
router.delete('/:id', controller.deleteTerceirizadoPagamento);

module.exports = router;
