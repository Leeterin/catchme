const express = require('express');
const { requireAuth, viewerAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');
const {
  listFeedPosts, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, toggleSave, listComments, createComment, deleteComment,
} = require('../controllers/feed.controller');

const router = express.Router();

// 리뷰 목록·댓글 보기는 가입 안 하고 둘러보는 사람도 볼 수 있음 (쓰기·저장·좋아요는 아래 requireAuth부터)
router.get('/', viewerAuth, listFeedPosts);
router.get('/:id/comments', viewerAuth, listComments);

router.use(requireAuth);

router.post('/', writeLimiter, createFeedPost);
router.delete('/comments/:commentId', deleteComment); // '/:id'보다 먼저 등록
router.patch('/:id', writeLimiter, updateFeedPost);
router.delete('/:id', deleteFeedPost);
router.post('/:id/like', toggleLike);
router.post('/:id/save', toggleSave);
router.post('/:id/comments', writeLimiter, createComment);

module.exports = router;
