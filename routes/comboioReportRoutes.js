// routes/comboioReportRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const comboioReportController = require('../controllers/comboioReportController');

router.use(authMiddleware);

router.get('/', comboioReportController.getReport);

module.exports = router;
