const express = require('express');
const { getUserAvatar, getUserReviewAvatar } = require('../controllers/avatar.controller');

const router = express.Router();

router.get('/:userId/avatar', getUserAvatar);
router.get('/:userId/review-avatar', getUserReviewAvatar);

module.exports = router;
