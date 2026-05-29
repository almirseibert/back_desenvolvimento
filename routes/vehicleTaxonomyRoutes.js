const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/vehicleTaxonomyController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', ctrl.getTree);

router.post('/groups', ctrl.createGroup);
router.put('/groups/:id', ctrl.updateGroup);
router.delete('/groups/:id', ctrl.deleteGroup);

router.post('/types', ctrl.createType);
router.put('/types/:id', ctrl.updateType);
router.delete('/types/:id', ctrl.deleteType);

router.post('/sub-types', ctrl.createSubType);
router.put('/sub-types/:id', ctrl.updateSubType);
router.delete('/sub-types/:id', ctrl.deleteSubType);

module.exports = router;
