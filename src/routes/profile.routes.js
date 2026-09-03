const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const { updateProfile, updateLocation, deleteAccount } = Object.fromEntries(Object.entries(require('../controllers/profile.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.patch('/', updateProfile);
router.patch('/location', updateLocation);
router.post('/delete', deleteAccount);

module.exports = router;
