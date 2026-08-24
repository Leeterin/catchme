const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  listMeetups, createMeetup, updateMeetup, cancelMeetup,
  joinMeetup, leaveMeetup, listJoinRequests, approveJoinRequest, declineJoinRequest,
  suggestedFriends,
} = require('../controllers/meetups.controller');

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

module.exports = router;
