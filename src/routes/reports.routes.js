const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const { createReport, getTrustInfo } = Object.fromEntries(Object.entries(require('../controllers/reports.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.post('/', createReport);
router.get('/trust/:userId', getTrustInfo);

module.exports = router;
