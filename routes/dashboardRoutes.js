const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardController');

router.get('/home-summary', controller.getHomeSummary);

module.exports = router;
