const express = require('express');
const { getUserAvatar } = require('../controllers/avatar.controller');

const router = express.Router();

router.get('/:userId/avatar', getUserAvatar);

module.exports = router;
