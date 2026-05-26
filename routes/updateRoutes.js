// routes/updateRoutes.js
const express = require('express');
const router = express.Router();
// NOTA: Agora usamos o 'updateController' que criamos
const updateController = require('../controllers/updateController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware); // Protege todas as rotas de 'updates'

// Rota para buscar TODAS as atualizações (corrige o 404 da AdminPage)
// Corresponde a GET /api/updates
router.get('/', updateController.getAllUpdates);

// Rota para criar uma nova atualização (para a AdminPage)
// Corresponde a POST /api/updates
router.post('/', updateController.createUpdate);

// Rota para deletar uma atualização (para a AdminPage)
// Corresponde a DELETE /api/updates/:id
router.delete('/:id', updateController.deleteUpdate);

module.exports = router;