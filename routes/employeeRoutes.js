const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// --- ROTA DE MIGRAÇÃO (SINCRONIZAÇÃO) ---
router.post('/sync-users', employeeController.syncActiveEmployeesToUsers);

// Rotas CRUD padrão
router.get('/', employeeController.getAllEmployees);
router.get('/:id', employeeController.getEmployeeById);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);

// Rotas especializadas
router.get('/:id/history', employeeController.getEmployeeHistory);
router.put('/:id/status', employeeController.updateEmployeeStatus);

// Novas rotas de recursos humanos
router.post('/:id/toxicological-exam', employeeController.registerExamUpdate);
router.post('/:id/leave-status', employeeController.updateLeaveStatus);

module.exports = router;