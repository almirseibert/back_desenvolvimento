// routes/expenseRoutes.js
const express = require('express');
const router = express.Router();
const {
    listExpenses,
    createExpense,
    updateExpense,
    deleteExpense
} = require('../controllers/expenseController');
const authMiddleware = require('../middlewares/authMiddleware');

// Protege todas as rotas de despesas
router.use(authMiddleware);

// Rota para listar todas as despesas (GET /api/expenses)
router.get('/', listExpenses);

// Rota para criar nova despesa manual (POST /api/expenses)
router.post('/', createExpense);

// Rota para atualizar despesa manual (PUT /api/expenses/:id)
router.put('/:id', updateExpense);

// Rota para deletar despesa manual (DELETE /api/expenses/:id)
router.delete('/:id', deleteExpense);

module.exports = router;