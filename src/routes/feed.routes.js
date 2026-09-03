const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const asyncHandler = require('../lib/asyncHandler');
const {
  listFeedPosts, getPlaceDetail, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, listComments, createComment, deleteComment,
} = Object.fromEntries(Object.entries(require('../controllers/feed.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.use(requireAuth);

router.get('/', listFeedPosts);
router.get('/places/:placeId', getPlaceDetail); // '/:id'보다 먼저 등록
router.post('/', createFeedPost);
router.delete('/comments/:commentId', deleteComment); // '/:id'보다 먼저 등록
router.patch('/:id', updateFeedPost);
router.delete('/:id', deleteFeedPost);
router.post('/:id/like', toggleLike);
router.get('/:id/comments', listComments);
router.post('/:id/comments', createComment);

module.exports = router;
