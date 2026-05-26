const express = require('express');
const router = express.Router();
const agendaController = require('../controllers/agendaController');
const authMiddleware = require('../middlewares/authMiddleware'); 

// Todas as rotas de agenda são protegidas
router.use(authMiddleware);

// Rotas CRUD da Agenda
router.get('/', agendaController.getEventos);
router.post('/', agendaController.criarEvento);
router.put('/:id', agendaController.atualizarEvento);
router.delete('/:id', agendaController.deletarEvento);
router.put('/:id/concluir', agendaController.marcarConcluido);
router.patch('/:id/concluir', agendaController.marcarConcluido);
router.get('/notificacoes', agendaController.getNotificacoesPendentes);

module.exports = router;