// routes/fineRoutes.js
const express = require('express');
const router = express.Router();
const fineController = require('../controllers/fineController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rota de Upload do PDF da Multa (DEVE vir antes de /:id para evitar conflito)
router.post('/upload-pdf', fineController.uploadFinePdf);

// Rotas CRUD padrão
router.get('/', fineController.getAllFines);
router.get('/:id', fineController.getFineById);
router.post('/', fineController.createFine);
router.put('/:id', fineController.updateFine);
router.delete('/:id', fineController.deleteFine);

// Rota de Notificação
router.post('/:id/notify', fineController.notifyEmployee);

module.exports = router;