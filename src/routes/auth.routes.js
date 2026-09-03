const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { loginLimiter, signupLimiter, passwordResetLimiter } = require('../middleware/rateLimit.middleware');
const asyncHandler = require('../lib/asyncHandler');
// 컨트롤러의 모든 함수를 asyncHandler로 감싸서, async 핸들러 안의 에러가 항상 errorHandler로 넘어가게 함
const {
  signup, login, checkUsername, refresh, logout, getMe,
  kakaoLoginRedirect, kakaoCallback, naverLoginRedirect, naverCallback,
  forgotPassword, resetPassword,
} = Object.fromEntries(Object.entries(require('../controllers/auth.controller')).map(([k, v]) => [k, asyncHandler(v)]));

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
