const express = require('express');
const { getUserAvatar, getUserReviewAvatar } = require('../controllers/avatar.controller');

const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

router.get('/:userId/avatar', wrap(getUserAvatar));
router.get('/:userId/review-avatar', wrap(getUserReviewAvatar));

module.exports = router;
