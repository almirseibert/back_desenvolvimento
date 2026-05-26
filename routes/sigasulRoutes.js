const express = require('express');
const router = express.Router();
const c = require('../controllers/sigasulController');

router.get('/positions',              c.getPositions);
router.get('/positions/period',       c.getPositionsByPeriod);
router.get('/positions/vehicle/:plate', c.getPositionsByPlate);
router.get('/journeys',               c.getJourneys);
router.get('/journeys/simplified',    c.getJourneysSimplified);
router.get('/journeys/aggregate',     c.getJourneysAggregate);

module.exports = router;
