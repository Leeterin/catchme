const prisma = require('../lib/prisma');

// 관리자로 허용할 계정 - 이메일/아이디 둘 중 하나라도 일치하면 통과.
// 환경변수(ADMIN_EMAILS/ADMIN_USERNAMES, 쉼표구분)로 나중에 더 추가하거나 교체할 수 있게 해두되,
// 기본값으로 지금 쓰는 관리자 계정을 박아둠 - 이 미들웨어를 통과 못 하면 /api/admin/* 은 전부 403.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'catchme@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'catchmeadmin')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// requireAuth로 req.userId가 이미 채워진 뒤에 붙여씀 - 그 사람이 관리자 계정인지 DB에서 다시 확인함
// (토큰 위조로 다른 사람 흉내를 낼 수 없듯, 여기서도 매 요청마다 실제 계정 정보를 확인)
async function requireAdmin(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true, username: true },
    });
    if (!user) return res.status(401).json({ message: '로그인이 필요해요.' });

    const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase())
      || ADMIN_USERNAMES.includes(user.username.toLowerCase());
    if (!isAdmin) return res.status(403).json({ message: '관리자 계정이 아니에요.' });

    next();
  } catch (err) {
    console.error('[requireAdmin] error:', err);
    return res.status(500).json({ message: '권한 확인 중 오류가 발생했어요.' });
  }
}

// 관리자는 이메일/아이디로만 알아보니, 그 이메일·아이디를 다른 사람이 새로 가지면 관리자가 돼버림
// (예: 아무도 안 쓰는 관리자 아이디로 바꾸기, 관리자 이메일로 가입하기, 그 이메일을 적은 카카오 계정으로 가입하기).
// 그래서 관리자 이메일·아이디는 예약해두고 가입/아이디 변경/소셜 가입에서 새로 못 쓰게 막음 - 이미 그 값을 가진 계정은 그대로 관리자
function isReservedAdminEmail(email) {
  return typeof email === 'string' && ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
function isReservedAdminUsername(username) {
  return typeof username === 'string' && ADMIN_USERNAMES.includes(username.trim().toLowerCase());
}

module.exports = { requireAdmin, isReservedAdminEmail, isReservedAdminUsername };
