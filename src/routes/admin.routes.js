const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/admin.middleware');
const {
  getOverview,
  getDailyStats,
  listUsers, getUserDetail, suspendUser, unsuspendUser, deleteUser,
  listReports, getReportDetail, resolveReport,
  listFeedPosts, deleteFeedPost,
  listMeetups, cancelMeetup,
  listAdminLogs,
} = require('../controllers/admin.controller');

const router = express.Router();

// 로그인은 돼있어야 하고(requireAuth), 그중에서도 관리자 계정만 통과(requireAdmin) -
// 둘 다 통과 못 하면 이 밑의 어떤 엔드포인트도 응답하지 않음(401/403)
router.use(requireAuth, requireAdmin);

router.get('/overview', getOverview);
router.get('/stats/daily', getDailyStats);

router.get('/users', listUsers);
router.get('/users/:id', getUserDetail);
router.post('/users/:id/suspend', suspendUser);
router.post('/users/:id/unsuspend', unsuspendUser);
router.delete('/users/:id', deleteUser);

router.get('/reports', listReports);
router.get('/reports/:id', getReportDetail);
router.post('/reports/:id/resolve', resolveReport);

router.get('/feed-posts', listFeedPosts);
router.delete('/feed-posts/:id', deleteFeedPost);

router.get('/meetups', listMeetups);
router.post('/meetups/:id/cancel', cancelMeetup);

router.get('/logs', listAdminLogs);

module.exports = router;
