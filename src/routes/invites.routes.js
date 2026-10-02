const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const { inviteLimiter } = require('../middleware/rateLimit.middleware');
const {
  myAvailability, createInvite, listMyInvites, getInvite, respondInvite, confirmInvite, cancelInvite, claimInvite,
} = require('../controllers/invites.controller');

const router = express.Router();

// 약속 초대 링크 - 보기/응답은 로그인 없이도 가능 (비회원 참여)
router.get('/', requireAuth, listMyInvites);
router.post('/', requireAuth, inviteLimiter, createInvite);
router.get('/availability', requireAuth, myAvailability);
router.get('/:token', optionalAuth, getInvite);
router.post('/:token/respond', optionalAuth, inviteLimiter, respondInvite);
router.post('/:token/confirm', requireAuth, confirmInvite);
router.post('/:token/cancel', requireAuth, cancelInvite);
router.post('/:token/claim', requireAuth, claimInvite);

module.exports = router;
