const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  updateProfile,
  updateLocation,
  deleteAccount,
  listSavedLocations,
  saveSavedLocation,
  updateSavedLocation,
  deleteSavedLocation,
} = require('../controllers/profile.controller');

const router = express.Router();

router.use(requireAuth);

router.patch('/', updateProfile);
router.patch('/location', updateLocation);
router.post('/delete', deleteAccount);

// 자주 쓰는 출발지(집/회사/학교/직접입력)
router.get('/locations', listSavedLocations);
router.post('/locations', saveSavedLocation);
router.patch('/locations/:id', updateSavedLocation);
router.delete('/locations/:id', deleteSavedLocation);

module.exports = router;
