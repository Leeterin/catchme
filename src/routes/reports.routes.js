const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { createReport, getTrustInfo } = require('../controllers/reports.controller');

const router = express.Router();

router.use(requireAuth);

router.post('/', createReport);
router.get('/trust/:userId', getTrustInfo);

module.exports = router;
