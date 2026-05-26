const express = require('express');
const router = express.Router();
const tireController = require('../controllers/tireController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', tireController.getAllTires);
router.post('/', tireController.createTire);
router.put('/:id', tireController.updateTire);
router.post('/transaction', tireController.registerTransaction);
router.get('/:id/history', tireController.getTireHistory);
// Nova rota para histórico do VEÍCULO
router.get('/vehicle/:vehicleId/history', tireController.getVehicleTireHistory);

module.exports = router;