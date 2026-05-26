// routes/counterRoutes.js
const express = require('express');
const router = express.Router();
const counterController = require('../controllers/counterController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/:name', counterController.getCounter);
router.put('/:name', counterController.updateCounter);

module.exports = router;