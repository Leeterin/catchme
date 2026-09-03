const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const { listEvents, getEvent, createEvent, updateEvent, deleteEvent, matchCalendar, getFriendDaySchedule, getFriendMonthSchedule } = Object.fromEntries(Object.entries(require('../controllers/events.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.get('/', listEvents);
router.post('/', createEvent);
router.get('/match', matchCalendar); // /:id 보다 먼저 등록 (안 그러면 "match"가 id로 잡혀버림)
router.get('/friend/:username/month', getFriendMonthSchedule); // /:id 보다 먼저 등록
router.get('/friend/:username', getFriendDaySchedule); // /:id 보다 먼저 등록
router.get('/:id', getEvent);
router.patch('/:id', updateEvent);
router.delete('/:id', deleteEvent);

module.exports = router;
