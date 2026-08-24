const rateLimit = require('express-rate-limit');

// 로그인 - 무차별 대입(비밀번호 계속 시도) 공격 방어. IP 하나당 15분에 10번까지만
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '로그인 시도가 너무 많아요. 15분 후에 다시 시도해주세요.' },
});

// 회원가입 - 스팸 계정 대량 생성 방지. IP 하나당 1시간에 5번까지만
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '회원가입 시도가 너무 많아요. 나중에 다시 시도해주세요.' },
});

// 비밀번호 재설정 요청 - 이메일 스팸 발송 방지. IP 하나당 1시간에 5번까지만
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많아요. 나중에 다시 시도해주세요.' },
});

module.exports = { loginLimiter, signupLimiter, passwordResetLimiter };
