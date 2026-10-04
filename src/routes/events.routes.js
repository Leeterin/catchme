const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');
const { listEvents, getEvent, createEvent, updateEvent, deleteEvent, matchCalendar, getFriendDaySchedule, getFriendMonthSchedule, importEvents, fetchIcsProxy } = require('../controllers/events.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', listEvents);
router.post('/', createEvent);
router.post('/import', writeLimiter, importEvents); // 휴대폰 캘린더/캘린더 주소에서 가져온 일정 한꺼번에 저장
router.get('/ics', writeLimiter, fetchIcsProxy); // /:id 보다 먼저 등록
router.get('/match', matchCalendar); // /:id 보다 먼저 등록 (안 그러면 "match"가 id로 잡혀버림)
router.get('/friend/:username/month', getFriendMonthSchedule); // /:id 보다 먼저 등록
router.get('/friend/:username', getFriendDaySchedule); // /:id 보다 먼저 등록
router.get('/:id', getEvent);
router.patch('/:id', updateEvent);
router.delete('/:id', deleteEvent);

module.exports = router;
