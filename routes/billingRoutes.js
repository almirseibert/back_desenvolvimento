const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rota principal para listagem (suporta query params ?obraId=... ou ?obraId=all)
router.get('/', billingController.getDailyLogs);

// Rota específica por obra (legado/compatibilidade)
router.get('/obra/:obraId', billingController.getDailyLogs);

router.post('/', billingController.upsertDailyLog);
router.delete('/:id', billingController.deleteDailyLog);

module.exports = router;