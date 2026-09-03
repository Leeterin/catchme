const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const { getSettings, updateSettings } = Object.fromEntries(Object.entries(require('../controllers/settings.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.get('/', getSettings);
router.patch('/', updateSettings);

module.exports = router;
