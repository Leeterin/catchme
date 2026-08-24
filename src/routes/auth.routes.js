const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { loginLimiter, signupLimiter, passwordResetLimiter } = require('../middleware/rateLimit.middleware');
const {
  signup, login, checkUsername, refresh, logout, getMe,
  kakaoLoginRedirect, kakaoCallback, naverLoginRedirect, naverCallback,
  forgotPassword, resetPassword,
} = require('../controllers/auth.controller');

const router = express.Router();

router.post('/signup', signupLimiter, signup);
router.post('/login', loginLimiter, login);
router.get('/check-username', checkUsername);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', requireAuth, getMe);
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);

router.get('/kakao/login', kakaoLoginRedirect);
router.get('/kakao/callback', kakaoCallback);
router.get('/naver/login', naverLoginRedirect);
router.get('/naver/callback', naverCallback);

module.exports = router;
