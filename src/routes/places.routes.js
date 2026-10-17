const express = require('express');
const { requireAuth, viewerAuth } = require('../middleware/auth.middleware');
const { searchPlaces, getPlaceStats } = require('../controllers/places.controller');

const router = express.Router();

// 장소별 별점·리뷰 수 집계는 둘러보는 사람도 볼 수 있음 (장소 검색은 외부 검색 API 비용이 들어서 로그인 필요)
router.get('/stats', viewerAuth, getPlaceStats);

router.use(requireAuth);

router.get('/search', searchPlaces);

module.exports = router;
