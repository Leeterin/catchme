const prisma = require('./prisma');

// 유저 목록에 프로필 사진 "있는지 여부"(hasAvatar/hasReviewAvatar)만 붙임.
// 사진 원본(base64, 장당 수십 KB)을 DB에서 꺼내지 않고 DB 안에서 있는지만 확인함 - 실제 이미지는 캐싱되는 /api/users/:id/avatar 로 따로 받음
async function attachAvatarFlags(users) {
  const list = users.filter(Boolean);
  const ids = [...new Set(list.map((u) => u.id))];
  if (ids.length === 0) return users;
  const rows = await prisma.$queryRaw`
    SELECT id, "profileImageUrl" IS NOT NULL AS "hasAvatar", "reviewAvatarUrl" IS NOT NULL AS "hasReviewAvatar"
    FROM users WHERE id = ANY(${ids})`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of list) {
    const r = byId.get(u.id);
    u.hasAvatar = r ? r.hasAvatar : false;
    u.hasReviewAvatar = r ? r.hasReviewAvatar : false;
  }
  return users;
}

module.exports = { attachAvatarFlags };
