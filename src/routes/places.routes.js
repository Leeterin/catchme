const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const { searchPlaces } = Object.fromEntries(Object.entries(require('../controllers/places.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.get('/search', searchPlaces);

module.exports = router;
