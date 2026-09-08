const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { updateProfile, updateLocation, deleteAccount } = require('../controllers/profile.controller');

const router = express.Router();

router.use(requireAuth);

router.patch('/', updateProfile);
router.patch('/location', updateLocation);
router.post('/delete', deleteAccount);

module.exports = router;
