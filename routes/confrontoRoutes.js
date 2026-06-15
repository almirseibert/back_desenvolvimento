const express = require('express');
const router = express.Router();
const confrontoController = require('../controllers/confrontoController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', confrontoController.list);
router.post('/reprocessar', confrontoController.reprocess);
router.get('/:placa/:data', confrontoController.detail);

module.exports = router;
