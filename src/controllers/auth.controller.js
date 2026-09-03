const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { validateSignupInput } = require('../lib/validators');

const SALT_ROUNDS = 12;
const REFRESH_TOKEN_DAYS = 30;

// 액세스 토큰(짧게, API 호출마다 검사) - 유출돼도 피해가 크지 않게 유효기간을 짧게 둠
function signAccessToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
}

// 리프레시 토큰(길게, DB에 저장해둠) - 액세스 토큰이 만료됐을 때 재로그인 없이 새로 발급받는 용도
async function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
  return token;
}

// 응답에 절대 passwordHash가 섞여 나가지 않도록 화이트리스트로만 반환
function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    profileImageUrl: user.profileImageUrl,
    phone: user.phone,
    bio: user.bio,
    phonePublic: user.phonePublic,
    emailPublic: user.emailPublic,
    locationSharing: !!user.locationSharing,
    createdAt: user.createdAt,
  };
}

async function signup(req, res) {
  try {
    const { email, username, name, password, phone } = req.body;

    const { valid, errors } = validateSignupInput({ email, username, name, password, phone });
    if (!valid) {
      return res.status(400).json({ message: '입력값을 확인해주세요.', errors });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();

    // 이메일/아이디 중복 체크 (둘 중 하나라도 겹치면 409)
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { username: normalizedUsername }],
      },
      select: { email: true, username: true },
    });

    if (existing) {
      const errors = {};
      if (existing.email === normalizedEmail) errors.email = '이미 사용 중인 이메일이에요.';
      if (existing.username === normalizedUsername) errors.username = '이미 사용 중인 아이디예요.';
      return res.status(409).json({ message: '이미 가입된 정보가 있어요.', errors });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        username: normalizedUsername,
        name: name.trim(),
        passwordHash,
        phone: phone || null,
      },
    });

    const token = signAccessToken(user.id);
    const refreshToken = await createRefreshToken(user.id);

    return res.status(201).json({
      message: '회원가입이 완료됐어요.',
      token,
      refreshToken,
      user: toPublicUser(user),
    });
  } catch (err) {
    // Prisma unique 제약 위반 등 예상치 못한 DB 에러에 대한 안전망
    if (err.code === 'P2002') {
      return res.status(409).json({ message: '이미 사용 중인 이메일 또는 아이디예요.' });
    }
    console.error('[signup] error:', err);
    return res.status(500).json({ message: '회원가입 처리 중 오류가 발생했어요.' });
  }
}

async function login(req, res) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ message: '아이디(또는 이메일)와 비밀번호를 입력해주세요.' });
    }

    const normalized = emailOrUsername.trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: normalized }, { username: normalized }] },
    });

    // 계정이 없을 때와 비밀번호가 틀렸을 때를 같은 메시지로 응답해서
    // 어떤 아이디가 존재하는지 추측하지 못하게 함
    const invalidMsg = { message: '아이디 또는 비밀번호가 올바르지 않아요.' };
    if (!user) return res.status(401).json(invalidMsg);
    if (!user.passwordHash) {
      return res.status(401).json({ message: '카카오 또는 네이버 로그인으로 가입한 계정이에요. 그 방법으로 로그인해주세요.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) return res.status(401).json(invalidMsg);

    const token = signAccessToken(user.id);
    const refreshToken = await createRefreshToken(user.id);

    return res.json({
      message: '로그인 성공',
      token,
      refreshToken,
      user: toPublicUser(user),
    });
  } catch (err) {
    console.error('[login] error:', err);
    return res.status(500).json({ message: '로그인 처리 중 오류가 발생했어요.' });
  }
}

// POST /api/auth/refresh   body: { refreshToken }
// 액세스 토큰이 만료됐을 때, 재로그인 없이 새 액세스 토큰(+새 리프레시 토큰)을 발급해줌.
// 리프레시 토큰은 쓸 때마다 새 걸로 교체(rotate)해서, 하나가 유출돼도 오래 못 써먹게 함.
async function refresh(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ message: '리프레시 토큰이 필요해요.' });

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
  if (!stored) return res.status(401).json({ message: '유효하지 않은 리프레시 토큰이에요. 다시 로그인해주세요.' });

  if (stored.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: stored.id } }).catch(() => {});
    return res.status(401).json({ message: '로그인이 만료됐어요. 다시 로그인해주세요.' });
  }

  // 기존 토큰은 지우고 새 토큰을 발급 (재사용 방지)
  await prisma.refreshToken.delete({ where: { id: stored.id } });
  const newAccessToken = signAccessToken(stored.userId);
  const newRefreshToken = await createRefreshToken(stored.userId);

  return res.json({ token: newAccessToken, refreshToken: newRefreshToken });
}

// POST /api/auth/logout   body: { refreshToken }
async function logout(req, res) {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }
  return res.json({ message: '로그아웃했어요.' });
}

// GET /api/auth/check-username?username=abc — 프론트에서 실시간 중복확인용
async function checkUsername(req, res) {
  const username = String(req.query.username || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ message: '아이디를 입력해주세요.' });

  const exists = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return res.json({ available: !exists });
}

// GET /api/auth/me — 로그인된 내 정보 (소셜 로그인 리다이렉트 직후 프론트가 토큰만 받고 사용자 정보를 마저 받아올 때 사용)
async function getMe(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ message: '사용자를 찾을 수 없어요.' });
  return res.json({ user: toPublicUser(user) });
}

// 소셜 로그인(카카오/네이버)으로 들어온 사람을 기존 계정과 연결하거나 새 계정을 만듦
async function findOrCreateSocialUser({ provider, providerId, email, name }) {
  const idField = provider === 'kakao' ? 'kakaoId' : 'naverId';
  let user = await prisma.user.findUnique({ where: { [idField]: providerId } });

  if (!user && email) {
    // 같은 이메일로 이미 가입된 계정이 있으면, 그 계정에 소셜 로그인만 새로 연결
    const existingByEmail = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existingByEmail) {
      user = await prisma.user.update({ where: { id: existingByEmail.id }, data: { [idField]: providerId } });
    }
  }

  if (!user) {
    let username = `${provider}_${providerId}`.slice(0, 20);
    const dupe = await prisma.user.findUnique({ where: { username } });
    if (dupe) username = `${username}_${Date.now().toString().slice(-4)}`;

    user = await prisma.user.create({
      data: {
        email: email ? email.toLowerCase() : `${username}@${provider}.catchme.local`,
        username,
        name: name || (provider === 'kakao' ? '카카오 사용자' : '네이버 사용자'),
        passwordHash: null,
        [idField]: providerId,
      },
    });
  }

  const token = signAccessToken(user.id);
  const refreshToken = await createRefreshToken(user.id);
  return { token, refreshToken };
}

// 카카오/네이버 로그인 시작~콜백 사이에 이 콜백 요청이 정말 우리가 보낸 리다이렉트에서 돌아온 게 맞는지
// 확인하는 CSRF 방지용 state. 서버에 따로 저장(세션/쿠키)하지 않고, JWT로 서명해서 그 안에 실어 보냄 -
// 콜백에서는 서명과 provider가 일치하는지만 검증하면 되니 별도 저장소 없이도 위조를 막을 수 있음.
// 유효시간은 로그인 화면에서 승인하는 데 걸리는 시간을 넉넉히 잡아 10분으로 둠.
function signOAuthState(provider) {
  return jwt.sign({ provider, nonce: crypto.randomBytes(8).toString('hex') }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
function verifyOAuthState(provider, state) {
  if (!state) return false;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    return payload.provider === provider;
  } catch (err) {
    return false;
  }
}

// GET /api/auth/kakao/login — 카카오 로그인 화면으로 리다이렉트
function kakaoLoginRedirect(req, res) {
  const state = signOAuthState('kakao');
  const url = `https://kauth.kakao.com/oauth/authorize?response_type=code&client_id=${process.env.KAKAO_REST_API_KEY}&redirect_uri=${encodeURIComponent(process.env.KAKAO_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  res.redirect(url);
}

// GET /api/auth/kakao/callback?code=&state= — 카카오 로그인 후 돌아오는 콜백
async function kakaoCallback(req, res) {
  const { code, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || '/';
  if (!code) return res.redirect(`${frontendUrl}?authError=missing_code`);
  if (!verifyOAuthState('kakao', state)) return res.redirect(`${frontendUrl}?authError=invalid_state`);

  try {
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.KAKAO_REST_API_KEY,
        client_secret: process.env.KAKAO_CLIENT_SECRET || '',
        redirect_uri: process.env.KAKAO_REDIRECT_URI,
        code: String(code),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('카카오 토큰 발급 실패: ' + JSON.stringify(tokenData));

    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    const kakaoAccount = profile.kakao_account || {};
    const email = kakaoAccount.email || null;
    const nickname = (kakaoAccount.profile && kakaoAccount.profile.nickname) || null;

    const { token, refreshToken } = await findOrCreateSocialUser({
      provider: 'kakao', providerId: String(profile.id), email, name: nickname,
    });

    return res.redirect(`${frontendUrl}#token=${token}&refreshToken=${refreshToken}`);
  } catch (err) {
    console.error('[kakao callback] error:', err);
    return res.redirect(`${frontendUrl}?authError=kakao_failed`);
  }
}

// GET /api/auth/naver/login — 네이버 로그인 화면으로 리다이렉트
function naverLoginRedirect(req, res) {
  const state = signOAuthState('naver');
  const url = `https://nid.naver.com/oauth2.0/authorize?response_type=code&client_id=${process.env.NAVER_LOGIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.NAVER_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  res.redirect(url);
}

// GET /api/auth/naver/callback?code=&state= — 네이버 로그인 후 돌아오는 콜백
async function naverCallback(req, res) {
  const { code, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || '/';
  if (!code) return res.redirect(`${frontendUrl}?authError=missing_code`);
  if (!verifyOAuthState('naver', state)) return res.redirect(`${frontendUrl}?authError=invalid_state`);

  try {
    const tokenUrl = `https://nid.naver.com/oauth2.0/token?grant_type=authorization_code&client_id=${process.env.NAVER_LOGIN_CLIENT_ID}&client_secret=${process.env.NAVER_LOGIN_CLIENT_SECRET}&code=${code}&state=${state}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('네이버 토큰 발급 실패: ' + JSON.stringify(tokenData));

    const profileRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profileData = await profileRes.json();
    const p = profileData.response || {};
    const email = p.email || null;
    const name = p.name || p.nickname || null;

    const { token, refreshToken } = await findOrCreateSocialUser({
      provider: 'naver', providerId: String(p.id), email, name,
    });

    return res.redirect(`${frontendUrl}#token=${token}&refreshToken=${refreshToken}`);
  } catch (err) {
    console.error('[naver callback] error:', err);
    return res.redirect(`${frontendUrl}?authError=naver_failed`);
  }
}

// POST /api/auth/forgot-password   body: { email }
// 이메일이 실제로 가입돼있는지 여부를 알려주지 않기 위해, 어떤 경우든 항상 같은 성공 메시지를 반환함
async function forgotPassword(req, res) {
  const { email } = req.body;
  const generic = { message: '입력하신 이메일로 가입된 계정이 있다면, 비밀번호 재설정 링크를 보내드렸어요.' };
  if (!email) return res.json(generic);

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  // 소셜 로그인 전용 계정(비밀번호 없음)은 재설정 대상이 아니므로 여기서도 조용히 무시함
  if (!user || !user.passwordHash) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30분 동안만 유효

  await prisma.passwordResetToken.create({ data: { tokenHash, userId: user.id, expiresAt } });

  const frontendUrl = process.env.FRONTEND_URL || '';
  const resetLink = `${frontendUrl}#resetPasswordToken=${rawToken}`;

  try {
    await sendResetEmail(user.email, resetLink);
  } catch (err) {
    console.error('[forgot-password] 이메일 발송 실패:', err);
    // 이메일 발송이 실패해도 공격자에게 힌트를 주지 않기 위해 같은 성공 메시지를 반환함
  }

  return res.json(generic);
}

// Resend API로 재설정 링크 메일을 보냄 (RESEND_API_KEY 환경변수 필요)
async function sendResetEmail(toEmail, resetLink) {
  if (!process.env.RESEND_API_KEY) {
    console.error('[forgot-password] RESEND_API_KEY가 설정되지 않아 이메일을 보낼 수 없어요.');
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'CATCHME <onboarding@resend.dev>',
      to: [toEmail],
      subject: 'CATCHME 비밀번호 재설정',
      html: `
        <div style="font-family:sans-serif;max-width:420px;margin:0 auto;">
          <h2>비밀번호 재설정</h2>
          <p>아래 버튼을 눌러 새 비밀번호를 설정해주세요. 이 링크는 30분 동안만 유효해요.</p>
          <p><a href="${resetLink}" style="display:inline-block;padding:12px 20px;background:#38BDF8;color:#fff;border-radius:10px;text-decoration:none;">비밀번호 재설정하기</a></p>
          <p style="color:#888;font-size:13px;">본인이 요청한 게 아니라면 이 메일을 무시하셔도 돼요.</p>
        </div>
      `,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API 오류 (${response.status}): ${body}`);
  }
}

// POST /api/auth/reset-password   body: { token, newPassword }
async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ message: '토큰과 새 비밀번호가 필요해요.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: '비밀번호는 8자 이상이어야 해요.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken || resetToken.used || resetToken.expiresAt < new Date()) {
    return res.status(400).json({ message: '링크가 만료됐거나 이미 사용됐어요. 다시 요청해주세요.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used: true } }),
    // 비밀번호가 바뀌었으니, 기존에 로그인돼있던 다른 기기들도 전부 다시 로그인하도록 리프레시 토큰을 모두 무효화함
    prisma.refreshToken.deleteMany({ where: { userId: resetToken.userId } }),
  ]);

  return res.json({ message: '비밀번호가 변경됐어요. 새 비밀번호로 로그인해주세요.' });
}

module.exports = {
  signup, login, checkUsername, refresh, logout, toPublicUser, getMe,
  kakaoLoginRedirect, kakaoCallback, naverLoginRedirect, naverCallback,
  forgotPassword, resetPassword,
};
