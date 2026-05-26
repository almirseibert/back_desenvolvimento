// routes/diarioDeBordoRoutes.js
const express = require('express');
const router = express.Router();
const diarioDeBordoController = require('../controllers/diarioDeBordoController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', diarioDeBordoController.getAllDiarioDeBordo);
router.get('/:id', diarioDeBordoController.getDiarioDeBordoById);
router.post('/', diarioDeBordoController.createDiarioDeBordo);
router.put('/:id', diarioDeBordoController.updateDiarioDeBordo);
router.delete('/:id', diarioDeBordoController.deleteDiarioDeBordo);

// Novas rotas para gerenciar a jornada
router.post('/start', diarioDeBordoController.startJourney);
router.put('/:id/end', diarioDeBordoController.endJourney);
router.put('/:id/start-break', diarioDeBordoController.startBreak);
router.put('/:id/end-break', diarioDeBordoController.endBreak);

module.exports = router;