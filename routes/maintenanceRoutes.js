const express = require('express');
const router = express.Router();
const maintenanceController = require('../controllers/maintenanceController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- Rotas para Manutenções Programadas (Relatos) ---
router.get('/scheduled', maintenanceController.getProgramadas);
router.post('/scheduled', maintenanceController.createProgramada);

// --- Rotas para Manutenções Executadas ---
router.get('/executed', maintenanceController.getExecutadas);
router.post('/executed', maintenanceController.createExecutada);

module.exports = router;