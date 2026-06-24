// routes/partnerFuelCreditsRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/partnerFuelCreditsController');

// authMiddleware é aplicado globalmente no server.js para todas as rotas
// abaixo de apiRouter.use(authMiddleware).

router.get('/', ctrl.listBalances);
router.get('/:partnerId', ctrl.getPartnerDetail);
router.get('/:partnerId/entries', ctrl.getEntries);
router.post('/', ctrl.createCredit);
router.post('/:partnerId/adjustment', ctrl.createAdjustment);
router.put('/entries/:entryId', ctrl.updateCreditEntry);
router.delete('/entries/:entryId', ctrl.deleteCreditEntry);

module.exports = router;
