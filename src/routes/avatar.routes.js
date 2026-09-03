const express = require('express');
const asyncHandler = require('../lib/asyncHandler');
const { getUserAvatar } = Object.fromEntries(Object.entries(require('../controllers/avatar.controller')).map(([k, v]) => [k, asyncHandler(v)]));

const router = express.Router();

router.get('/:userId/avatar', getUserAvatar);

module.exports = router;
