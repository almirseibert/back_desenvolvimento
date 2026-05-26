const express = require('express');
const router = express.Router();
const revisionController = require('../controllers/revisionController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- Rotas de Revisão ---

// 1. Buscar todos os planos de revisão (Listagem principal)
router.get('/', revisionController.getAllRevisionPlans);

// 2. Criar um novo plano de revisão
router.post('/', revisionController.createRevisionPlan);

// 3. Atualizar/Agendar um plano existente
// O frontend envia o ID do VEÍCULO na URL
router.put('/:id', revisionController.updateRevisionPlan);

// 4. Concluir uma revisão
// Rota flexível: aceita chamada direta ou com ID na URL, 
// pois o controller verifica req.params E req.body
router.post('/complete', revisionController.completeRevision);
router.post('/complete/:id', revisionController.completeRevision);

// 5. Deletar um plano de revisão
router.delete('/:id', revisionController.deleteRevisionPlan);

module.exports = router;