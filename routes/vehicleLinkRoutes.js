// routes/vehicleLinkRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const vehicleLinkController = require('../controllers/vehicleLinkController');

router.use(authMiddleware);

router.get('/:vehicleId', vehicleLinkController.listLinks);
router.post('/', vehicleLinkController.createLink);
router.delete('/:id', vehicleLinkController.removeLink);

module.exports = router;
