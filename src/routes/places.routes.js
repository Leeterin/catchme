const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { searchPlaces, getPlaceStats } = require('../controllers/places.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/search', searchPlaces);
router.get('/stats', getPlaceStats);

module.exports = router;
