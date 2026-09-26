const prisma = require('../lib/prisma');

// base64 데이터 URL(data:image/...;base64,...)을 진짜 이미지 파일처럼 서빙하는 공용 로직 -
// 브라우저가 한 번 받은 뒤 캐싱해두고 재사용해서, 목록을 열 때마다 사진을 통째로 다시 안 받아오게 함.
function serveBase64Image(dataUrl, res) {
  if (!dataUrl) return res.status(404).end();
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return res.status(404).end();

  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');

  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=604800, immutable'); // 1주일 동안 브라우저가 다시 안 물어보고 캐시 그대로 씀
  return res.send(buffer);
}

// GET /api/users/:userId/avatar
// 로그인 없이도 볼 수 있게(공개) 열어둠 - <img> 태그는 인증 헤더를 못 보내기 때문
async function getUserAvatar(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { profileImageUrl: true },
  });
  return serveBase64Image(user ? user.profileImageUrl : null, res);
}

// GET /api/users/:userId/review-avatar
// "리뷰용 프로필" 사진 - 실명 프로필 사진과 별개로, 소식/커뮤니티 화면에서만 쓰는 사진.
// 설정 안 했으면(reviewAvatarUrl이 null) 404를 내려주고, 프론트에서 실명 프로필 사진으로 대체함.
async function getUserReviewAvatar(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { reviewAvatarUrl: true },
  });
  return serveBase64Image(user ? user.reviewAvatarUrl : null, res);
}

module.exports = { getUserAvatar, getUserReviewAvatar };
