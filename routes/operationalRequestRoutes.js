// routes/operationalRequestRoutes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/operationalRequestController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', controller.listarRequisicoes);
router.post('/', controller.criarRequisicao);
router.post('/solicitar-relatorio', controller.solicitarRelatorio);
router.put('/:id/resolver', controller.resolverRequisicao);
router.delete('/:id', controller.deletarRequisicao);

module.exports = router;
