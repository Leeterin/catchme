const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { getSettings, updateSettings } = require('../controllers/settings.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', getSettings);
router.patch('/', updateSettings);

module.exports = router;
