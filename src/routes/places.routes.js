const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { searchPlaces } = require('../controllers/places.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/search', searchPlaces);

module.exports = router;
