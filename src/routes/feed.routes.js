const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { listFeedPosts, getPlaceDetail, createFeedPost, updateFeedPost, deleteFeedPost } = require('../controllers/feed.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', listFeedPosts);
router.get('/places/:placeId', getPlaceDetail); // '/:id'보다 먼저 등록
router.post('/', createFeedPost);
router.patch('/:id', updateFeedPost);
router.delete('/:id', deleteFeedPost);

module.exports = router;
