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

// 게시물/댓글/친구요청 등 컨텐츠 작성 - 도배(스팸) 방지. IP 하나당 10분에 20번까지만
// (2026-09-30 보안 감사 High 3번 - 이런 쓰기성 엔드포인트에 전용 rate limit이 전혀 없었음)
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '너무 자주 시도하고 있어요. 잠시 후 다시 시도해주세요.' },
});

// 채팅 이미지 업로드 - 일반 텍스트 채팅보다는 느슨하게(정상적인 대화에서도 사진을 여러 장 보낼 수 있어서),
// 그래도 무제한은 아니게. IP 하나당 10분에 40번까지만
const imageUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '이미지를 너무 자주 보내고 있어요. 잠시 후 다시 시도해주세요.' },
});

// 신고 - 같은 사람을 반복 신고해서 신뢰도를 조작하는 것 방지 (2026-09-30 보안 감사 High 4번).
// IP 하나당 10분에 10번까지만
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '신고가 너무 잦아요. 잠시 후 다시 시도해주세요.' },
});

// 아이디 중복확인 - 인증/레이트리밋이 전혀 없어서 누구나 무제한으로 가입된 아이디를 스캔할 수 있었음
// (2026-09-30 보안 감사 Low 9번). IP 하나당 1분에 20번까지만
const usernameCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' },
});

// 약속 초대 링크 - 로그인 없이 쓸 수 있는 응답/생성이라 따로 제한. IP 하나당 10분에 30번까지만
const inviteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '너무 자주 시도하고 있어요. 잠시 후 다시 시도해주세요.' },
});

module.exports = {
  inviteLimiter,
  loginLimiter,
  signupLimiter,
  passwordResetLimiter,
  writeLimiter,
  imageUploadLimiter,
  reportLimiter,
  usernameCheckLimiter,
};
