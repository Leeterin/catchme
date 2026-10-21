const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');
const { listTestBots, setupTestBots, teardownTestBots } = require('../controllers/testbots.controller');

// 테스트 친구(봇) - 혼자서 약속 흐름을 확인하는 내 계정 전용 가짜 친구
const router = express.Router();
router.use(requireAuth);
router.get('/', listTestBots);
router.post('/setup', writeLimiter, setupTestBots);
router.post('/teardown', writeLimiter, teardownTestBots);

module.exports = router;
