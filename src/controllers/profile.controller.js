const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { toPublicUser } = require('./auth.controller');
const { USERNAME_RE, PHONE_RE, isAllowedImageDataUrl } = require('../lib/validators');

// 프로필 이미지는 외부 저장소 없이 DB에 base64 문자열로 바로 저장한다.
// 원본을 그대로 넣으면 너무 커지므로, 프론트에서 작게 압축(리사이즈)한 걸 받는 걸 전제로 하고
// 서버에서도 안전하게 최대 크기를 한 번 더 제한한다. (약 500KB)
const MAX_IMAGE_CHARS = 700000; // base64 문자열 기준 대략 500KB

// PATCH /api/profile   body: { name?, username?, bio?, phone?, phonePublic?, emailPublic?, profileImageUrl?, reviewNickname?, reviewAvatarUrl? }
async function updateProfile(req, res) {
  const { name, username, bio, phone, phonePublic, emailPublic, profileImageUrl, reviewNickname, reviewAvatarUrl } = req.body;
  const data = {};

  if (typeof name === 'string' && name.trim()) {
    const trimmedName = name.trim();
    if (trimmedName.length > 20) {
      return res.status(400).json({ message: '이름은 20자 이내로 입력해주세요.' });
    }
    data.name = trimmedName;
  }
  if (typeof bio === 'string') {
    if (bio.length > 200) {
      return res.status(400).json({ message: '소개글은 200자 이내로 입력해주세요.' });
    }
    data.bio = bio;
  }
  if (typeof phone === 'string') {
    if (phone && !PHONE_RE.test(phone)) {
      return res.status(400).json({ message: '올바른 휴대폰 번호 형식이 아니에요. (예: 010-1234-5678)' });
    }
    data.phone = phone;
  }
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
      if (!isAllowedImageDataUrl(profileImageUrl)) {
        return res.status(400).json({ message: '이미지 형식이 올바르지 않아요. (png/jpg/webp/gif만 가능)' });
      }
      if (profileImageUrl.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ message: '이미지 용량이 너무 커요. 더 작은 사진을 사용해주세요.' });
      }
      data.profileImageUrl = profileImageUrl;
    }
  }

  // 리뷰용(커뮤니티) 프로필 - 실명으로 리뷰 달기 창피할 수 있어서 만든 별도 닉네임/사진
  if (typeof reviewNickname === 'string') {
    const trimmed = reviewNickname.trim();
    if (trimmed.length > 20) {
      return res.status(400).json({ message: '리뷰 닉네임은 20자 이내로 입력해주세요.' });
    }
    data.reviewNickname = trimmed || null; // 빈 문자열로 보내면 다시 실명으로 돌아감
  }
  if (reviewAvatarUrl !== undefined) {
    if (reviewAvatarUrl === null || reviewAvatarUrl === '') {
      data.reviewAvatarUrl = null; // 삭제(기존 프로필 사진으로 대체됨)
    } else if (typeof reviewAvatarUrl === 'string') {
      if (!isAllowedImageDataUrl(reviewAvatarUrl)) {
        return res.status(400).json({ message: '이미지 형식이 올바르지 않아요. (png/jpg/webp/gif만 가능)' });
      }
      if (reviewAvatarUrl.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ message: '이미지 용량이 너무 커요. 더 작은 사진을 사용해주세요.' });
      }
      data.reviewAvatarUrl = reviewAvatarUrl;
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

// ------------------------------------------------------------
// 자주 쓰는 출발지 (집/회사/학교/직접입력) - 다중 모임 장소 추천에서 매번 주소를 새로
// 검색하지 않고 바로 고를 수 있도록 내 정보에 저장해두는 기능
// ------------------------------------------------------------
const FIXED_LABELS = ['HOME', 'WORK', 'SCHOOL'];
const MAX_CUSTOM_LOCATIONS = 10;

function serializeSavedLocation(loc) {
  return {
    id: loc.id,
    label: loc.label,
    customLabel: loc.customLabel,
    displayName: loc.label === 'CUSTOM' ? loc.customLabel : { HOME: '집', WORK: '회사', SCHOOL: '학교' }[loc.label],
    address: loc.address,
    lat: loc.lat,
    lon: loc.lon,
  };
}

// GET /api/profile/locations
async function listSavedLocations(req, res) {
  const locations = await prisma.savedLocation.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ locations: locations.map(serializeSavedLocation) });
}

// POST /api/profile/locations   body: { label: 'HOME'|'WORK'|'SCHOOL'|'CUSTOM', customLabel?, address, lat, lon }
// HOME/WORK/SCHOOL은 이미 있으면 덮어씀(유저당 하나씩). CUSTOM은 매번 새로 생성됨(개수 제한 있음)
async function saveSavedLocation(req, res) {
  const { label, customLabel, address, lat, lon } = req.body;

  if (!FIXED_LABELS.includes(label) && label !== 'CUSTOM') {
    return res.status(400).json({ message: '라벨 값이 올바르지 않아요.' });
  }
  if (typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({ message: '주소를 입력해주세요.' });
  }
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ message: '좌표가 올바르지 않아요.' });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ message: '좌표가 올바르지 않아요.' });
  }

  let trimmedCustomLabel = null;
  if (label === 'CUSTOM') {
    trimmedCustomLabel = (customLabel || '').trim();
    if (!trimmedCustomLabel) {
      return res.status(400).json({ message: '이름을 입력해주세요. (예: 헬스장, 본가)' });
    }
    if (trimmedCustomLabel.length > 10) {
      return res.status(400).json({ message: '이름은 10자 이내로 입력해주세요.' });
    }
  }

  if (FIXED_LABELS.includes(label)) {
    // 집/회사/학교는 유저당 하나씩만 - 이미 있으면 그 자리에 덮어씀
    const existing = await prisma.savedLocation.findFirst({ where: { userId: req.userId, label } });
    const saved = existing
      ? await prisma.savedLocation.update({ where: { id: existing.id }, data: { address: address.trim(), lat, lon } })
      : await prisma.savedLocation.create({ data: { userId: req.userId, label, address: address.trim(), lat, lon } });
    return res.json({ location: serializeSavedLocation(saved) });
  }

  const customCount = await prisma.savedLocation.count({ where: { userId: req.userId, label: 'CUSTOM' } });
  if (customCount >= MAX_CUSTOM_LOCATIONS) {
    return res.status(400).json({ message: `자주 쓰는 장소는 최대 ${MAX_CUSTOM_LOCATIONS}개까지 저장할 수 있어요.` });
  }

  const saved = await prisma.savedLocation.create({
    data: { userId: req.userId, label: 'CUSTOM', customLabel: trimmedCustomLabel, address: address.trim(), lat, lon },
  });
  return res.status(201).json({ location: serializeSavedLocation(saved) });
}

// PATCH /api/profile/locations/:id   body: { customLabel?, address?, lat?, lon? }
async function updateSavedLocation(req, res) {
  const { id } = req.params;
  const existing = await prisma.savedLocation.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ message: '저장된 장소를 찾을 수 없어요.' });
  }

  const { customLabel, address, lat, lon } = req.body;
  const data = {};
  if (existing.label === 'CUSTOM' && typeof customLabel === 'string') {
    const trimmed = customLabel.trim();
    if (!trimmed) return res.status(400).json({ message: '이름을 입력해주세요.' });
    if (trimmed.length > 10) return res.status(400).json({ message: '이름은 10자 이내로 입력해주세요.' });
    data.customLabel = trimmed;
  }
  if (typeof address === 'string' && address.trim()) data.address = address.trim();
  if (typeof lat === 'number' && typeof lon === 'number' && !Number.isNaN(lat) && !Number.isNaN(lon)) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ message: '좌표가 올바르지 않아요.' });
    }
    data.lat = lat;
    data.lon = lon;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }

  const updated = await prisma.savedLocation.update({ where: { id }, data });
  return res.json({ location: serializeSavedLocation(updated) });
}

// DELETE /api/profile/locations/:id
async function deleteSavedLocation(req, res) {
  const { id } = req.params;
  const existing = await prisma.savedLocation.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ message: '저장된 장소를 찾을 수 없어요.' });
  }
  await prisma.savedLocation.delete({ where: { id } });
  return res.json({ message: '삭제됐어요.' });
}

module.exports = {
  updateProfile,
  updateLocation,
  deleteAccount,
  listSavedLocations,
  saveSavedLocation,
  updateSavedLocation,
  deleteSavedLocation,
};
