const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const {
  listMeetups, createMeetup, updateMeetup, cancelMeetup,
  joinMeetup, leaveMeetup, listJoinRequests, approveJoinRequest, declineJoinRequest,
  suggestedFriends, createMeetupReview, listMeetupReviews,
} = Object.fromEntries(Object.entries(require('../controllers/meetups.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.get('/', listMeetups);
router.post('/', createMeetup);
router.get('/suggested-friends', suggestedFriends); // /:id 보다 먼저 등록
router.patch('/:id', updateMeetup);
router.post('/:id/cancel', cancelMeetup);
router.post('/:id/join', joinMeetup);
router.post('/:id/leave', leaveMeetup);
router.get('/:id/requests', listJoinRequests);
router.post('/:id/requests/:userId/approve', approveJoinRequest);
router.post('/:id/requests/:userId/decline', declineJoinRequest);
router.post('/:id/reviews', createMeetupReview);
router.get('/:id/reviews', listMeetupReviews);

module.exports = router;
