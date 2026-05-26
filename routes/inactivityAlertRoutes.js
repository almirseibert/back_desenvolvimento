// routes/inactivityAlertRoutes.js
const express = require('express');
const router = express.Router();
const inactivityAlertController = require('../controllers/inactivityAlertController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', inactivityAlertController.getAllInactivityAlerts);
router.post('/', inactivityAlertController.createInactivityAlert);
router.put('/:id', inactivityAlertController.updateInactivityAlert);
router.delete('/:id', inactivityAlertController.deleteInactivityAlert);

module.exports = router;