const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/analiseGerencialController');

// Role-gate: admin/master OU usuário com flag canAccessAnaliseGerencial.
// (authMiddleware já foi aplicado globalmente em server.js antes de chegar aqui.)
const requireAnaliseAccess = (req, res, next) => {
    const role = (req.user && req.user.role) || '';
    if (role === 'admin' || role === 'master' || (req.user && req.user.canAccessAnaliseGerencial)) {
        return next();
    }
    return res.status(403).json({ error: 'Acesso negado à Análise Gerencial.' });
};

router.use(requireAnaliseAccess);

router.get('/discrepancias/obras', ctrl.obrasOverview);
router.get('/discrepancias/obra/:obraId', ctrl.obraDetalhe);
router.get('/discrepancias/:id', ctrl.discrepanciaDrill);
router.post('/discrepancias/:id/justificar', ctrl.justificar);
router.post('/discrepancias/reprocessar', ctrl.reprocessar);
router.get('/jornadas/operador/:employeeId', ctrl.jornadasOperador);
router.get('/projecao/:obraId', ctrl.getProjecaoObra);

module.exports = router;
