const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');
const {
  listFeedPosts, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, listComments, createComment, deleteComment,
} = require('../controllers/feed.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', listFeedPosts);
router.post('/', writeLimiter, createFeedPost);
router.delete('/comments/:commentId', deleteComment); // '/:id'보다 먼저 등록
router.patch('/:id', writeLimiter, updateFeedPost);
router.delete('/:id', deleteFeedPost);
router.post('/:id/like', toggleLike);
router.get('/:id/comments', listComments);
router.post('/:id/comments', writeLimiter, createComment);

module.exports = router;
