// routes/terceiroContratoRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/terceiroContratoController');

router.use(authMiddleware);

router.get('/', controller.getTerceiroContratos);
router.post('/', controller.createTerceiroContrato);
router.put('/:id', controller.updateTerceiroContrato);
router.delete('/:id', controller.deleteTerceiroContrato);
router.post('/:id/pdf', controller.gerarContratoPdf);

module.exports = router;
