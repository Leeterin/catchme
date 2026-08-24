const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  listChatRooms,
  getOrCreateDirectRoom,
  listMessages,
  sendTextMessage,
  sendImageMessage,
  sendReservationRequest,
  acceptReservation,
  declineReservation,
  withdrawReservation,
  cancelReservationMessage,
  sendTimeProposal,
  voteTimeProposal,
  cancelTimeProposal,
  sendLocationSuggest,
  acceptLocationSuggest,
  declineLocationSuggest,
  withdrawLocationSuggest,
  cancelLocationSuggestMessage,
  createGroupRoom,
  leaveRoom,
  markRoomRead,
  setRoomMuted,
  listPins,
  createPin,
  updatePin,
  deletePin,
} = require('../controllers/chats.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', listChatRooms);
router.post('/direct', getOrCreateDirectRoom);
router.post('/group', createGroupRoom);
router.get('/:roomId/messages', listMessages);
router.post('/:roomId/messages', sendTextMessage);
router.post('/:roomId/images', sendImageMessage);
router.post('/:roomId/reservations', sendReservationRequest);
router.post('/:roomId/time-proposals', sendTimeProposal);
router.post('/:roomId/location-suggestions', sendLocationSuggest);
router.post('/:roomId/leave', leaveRoom);
router.post('/:roomId/read', markRoomRead);
router.post('/:roomId/mute', setRoomMuted);
router.get('/:roomId/pins', listPins);
router.post('/:roomId/pins', createPin);
router.patch('/pins/:pinId', updatePin);
router.delete('/pins/:pinId', deletePin);
router.post('/messages/:messageId/accept', acceptReservation);
router.post('/messages/:messageId/decline', declineReservation);
router.post('/messages/:messageId/withdraw', withdrawReservation);
router.post('/messages/:messageId/cancel', cancelReservationMessage);
router.post('/time-proposals/:messageId/vote', voteTimeProposal);
router.post('/time-proposals/:messageId/cancel', cancelTimeProposal);
router.post('/location-suggestions/:messageId/accept', acceptLocationSuggest);
router.post('/location-suggestions/:messageId/decline', declineLocationSuggest);
router.post('/location-suggestions/:messageId/withdraw', withdrawLocationSuggest);
router.post('/location-suggestions/:messageId/cancel', cancelLocationSuggestMessage);

module.exports = router;
