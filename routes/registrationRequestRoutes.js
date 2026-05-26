// routes/registrationRequestRoutes.js
const express = require('express');
const router = express.Router();
const registrationRequestController = require('../controllers/registrationRequestController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/', registrationRequestController.getAllRegistrationRequests);
router.post('/', registrationRequestController.createRegistrationRequest);
router.delete('/:id', registrationRequestController.deleteRegistrationRequest);

module.exports = router;