const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { toPublicUser } = require('./auth.controller');
const { USERNAME_RE } = require('../lib/validators');

// 프로필 이미지는 외부 저장소 없이 DB에 base64 문자열로 바로 저장한다.
// 원본을 그대로 넣으면 너무 커지므로, 프론트에서 작게 압축(리사이즈)한 걸 받는 걸 전제로 하고
// 서버에서도 안전하게 최대 크기를 한 번 더 제한한다. (약 500KB)
const MAX_IMAGE_CHARS = 700000; // base64 문자열 기준 대략 500KB

// PATCH /api/profile   body: { name?, username?, bio?, phone?, phonePublic?, emailPublic?, profileImageUrl? }
async function updateProfile(req, res) {
  const { name, username, bio, phone, phonePublic, emailPublic, profileImageUrl } = req.body;
  const data = {};

  if (typeof name === 'string' && name.trim()) data.name = name.trim();
  if (typeof bio === 'string') data.bio = bio;
  if (typeof phone === 'string') data.phone = phone;
  if (typeof phonePublic === 'boolean') data.phonePublic = phonePublic;
  if (typeof emailPublic === 'boolean') data.emailPublic = emailPublic;

  if (typeof username === 'string' && username.trim()) {
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      return res.status(400).json({ message: '아이디는 영문 소문자로 시작하는 3~20자(영문/숫자/./_)여야 해요.' });
    }
    const existing = await prisma.user.findUnique({ where: { username: normalized } });
    if (existing && existing.id !== req.userId) {
      return res.status(409).json({ message: '이미 사용 중인 아이디예요.' });
    }
    data.username = normalized;
  }

  if (profileImageUrl !== undefined) {
    if (profileImageUrl === null || profileImageUrl === '') {
      data.profileImageUrl = null; // 사진 삭제(기본 아바타로)
    } else if (typeof profileImageUrl === 'string') {
      if (!profileImageUrl.startsWith('data:image/')) {
        return res.status(400).json({ message: '이미지 형식이 올바르지 않아요.' });
      }
      if (profileImageUrl.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ message: '이미지 용량이 너무 커요. 더 작은 사진을 사용해주세요.' });
      }
      data.profileImageUrl = profileImageUrl;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }

  const user = await prisma.user.update({ where: { id: req.userId }, data });
  return res.json({ user: toPublicUser(user) });
}

// PATCH /api/profile/location   body: { lat, lon }  - 커뮤니티 화면에서 "현위치"를 선택했을 때 내 최근 위치를 저장
async function updateLocation(req, res) {
  const { lat, lon, sharing } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ message: '위치 좌표가 올바르지 않아요.' });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ message: '위치 좌표가 올바르지 않아요.' });
  }
  const data = { lastLat: lat, lastLon: lon, lastLocatedAt: new Date() };
  if (typeof sharing === 'boolean') data.locationSharing = sharing;
  await prisma.user.update({ where: { id: req.userId }, data });
  return res.json({ message: '위치를 저장했어요.' });
}

// POST /api/profile/delete   body: { password }  - 소셜 로그인 계정은 비밀번호가 없어서 확인 없이 바로 삭제됨
// 비밀번호를 다시 한 번 확인한 뒤에만 계정과 관련 데이터를 전부 삭제 (친구/채팅/일정/리프레시토큰 등은 DB의 cascade 설정으로 함께 삭제됨)
async function deleteAccount(req, res) {
  const { password } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    return res.status(404).json({ message: '사용자를 찾을 수 없어요.' });
  }

  if (user.passwordHash) {
    if (!password) {
      return res.status(400).json({ message: '비밀번호를 입력해주세요.' });
    }
    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: '비밀번호가 올바르지 않아요.' });
    }
  }

  await prisma.user.delete({ where: { id: req.userId } });
  return res.json({ message: '계정이 삭제됐어요.' });
}

module.exports = { updateProfile, updateLocation, deleteAccount };
