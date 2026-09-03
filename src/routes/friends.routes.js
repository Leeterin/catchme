const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const {
  searchUsers,
  listFriends,
  nearbyFriends,
  listRequests,
  sendRequest,
  acceptRequest,
  declineRequest,
  cancelRequest,
  removeFriend,
  blockUser,
  unblockUser,
  listBlocks,
  setPrivateAccess,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupMembers,
} = Object.fromEntries(Object.entries(require('../controllers/friends.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

// 이 라우터 아래 모든 엔드포인트는 로그인이 필요함
router.use(requireAuth);

router.get('/search', searchUsers);
router.get('/nearby', nearbyFriends); // '/'보다 먼저 등록
router.get('/', listFriends);
router.get('/requests', listRequests);
router.post('/requests', sendRequest);
router.post('/requests/:requestId/accept', acceptRequest);
router.post('/requests/:requestId/decline', declineRequest);
router.delete('/requests/:requestId', cancelRequest);
router.get('/blocks', listBlocks);
router.post('/block', blockUser);
router.post('/unblock', unblockUser);

// 친구 그룹 (인스타 "친한 친구"처럼 이름 붙여 만드는 그룹) - '/:friendId'보다 먼저 등록
router.get('/groups', listGroups);
router.post('/groups', createGroup);
router.patch('/groups/:groupId', renameGroup);
router.delete('/groups/:groupId', deleteGroup);
router.put('/groups/:groupId/members', setGroupMembers);

router.patch('/:friendId/private-access', setPrivateAccess);
router.delete('/:friendId', removeFriend);

module.exports = router;
