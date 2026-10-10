const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { imageUploadLimiter } = require('../middleware/rateLimit.middleware');
const {
  listChatRooms,
  listPendingForMe,
  getOrCreateDirectRoom,
  listMessages,
  sendTextMessage,
  sendImageMessage,
  sendReservationRequest,
  acceptReservation,
  declineReservation,
  withdrawReservation,
  cancelReservationMessage,
  restoreAvailabilityChoice,
  sendTimeProposal,
  voteTimeProposal,
  cancelTimeProposal,
  sendLocationSuggest,
  acceptLocationSuggest,
  declineLocationSuggest,
  withdrawLocationSuggest,
  cancelLocationSuggestMessage,
  voteLocationSuggest,
  fixLocationSuggest,
  createGroupRoom,
  leaveRoom,
  deleteRoom,
  markRoomRead,
  setRoomMuted,
  listPins,
  createPin,
  updatePin,
  deletePin,
  requestLocationRecommend,
  respondLocationRecommend,
  getLocationRecommendStatus,
  completeLocationRecommendNow,
  cancelLocationRecommend,
  getActiveLocationRecommend,
  deleteMessage,
} = require('../controllers/chats.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', listChatRooms);
router.get('/pending', listPendingForMe); // /:roomId 보다 먼저 등록
router.post('/direct', getOrCreateDirectRoom);
router.post('/group', createGroupRoom);
router.get('/:roomId/messages', listMessages);
router.post('/:roomId/messages', sendTextMessage);
router.post('/:roomId/images', imageUploadLimiter, sendImageMessage);
router.post('/:roomId/reservations', sendReservationRequest);
router.post('/:roomId/time-proposals', sendTimeProposal);
router.post('/:roomId/location-suggestions', sendLocationSuggest);
router.post('/:roomId/leave', leaveRoom);
router.delete('/:roomId', deleteRoom);
router.post('/:roomId/read', markRoomRead);
router.post('/:roomId/mute', setRoomMuted);
router.get('/:roomId/pins', listPins);
router.post('/:roomId/pins', createPin);
router.patch('/pins/:pinId', updatePin);
router.delete('/pins/:pinId', deletePin);
router.delete('/messages/:messageId', deleteMessage);
router.post('/messages/:messageId/accept', acceptReservation);
router.post('/messages/:messageId/decline', declineReservation);
router.post('/messages/:messageId/withdraw', withdrawReservation);
router.post('/messages/:messageId/cancel', cancelReservationMessage);
router.post('/messages/:messageId/restore-availability-choice', restoreAvailabilityChoice);
router.post('/time-proposals/:messageId/vote', voteTimeProposal);
router.post('/time-proposals/:messageId/cancel', cancelTimeProposal);
router.post('/location-suggestions/:messageId/accept', acceptLocationSuggest);
router.post('/location-suggestions/:messageId/decline', declineLocationSuggest);
router.post('/location-suggestions/:messageId/withdraw', withdrawLocationSuggest);
router.post('/location-suggestions/:messageId/cancel', cancelLocationSuggestMessage);
router.post('/location-suggestions/:messageId/vote', voteLocationSuggest);
router.post('/location-suggestions/:messageId/fix', fixLocationSuggest);
router.post('/:roomId/location-recommend', requestLocationRecommend);
router.get('/:roomId/location-recommend/active', getActiveLocationRecommend);
router.post('/location-recommend/:requestId/respond', respondLocationRecommend);
router.get('/location-recommend/:requestId/status', getLocationRecommendStatus);
router.post('/location-recommend/:requestId/complete', completeLocationRecommendNow);
router.post('/location-recommend/:requestId/cancel', cancelLocationRecommend);

module.exports = router;
