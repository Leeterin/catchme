const prisma = require('../lib/prisma');
const { ALLOWED_IMAGE_DATA_URL_RE } = require('../lib/validators');

// base64 데이터 URL(data:image/...;base64,...)을 진짜 이미지 파일처럼 서빙하는 공용 로직 -
// 브라우저가 한 번 받은 뒤 캐싱해두고 재사용해서, 목록을 열 때마다 사진을 통째로 다시 안 받아오게 함.
//
// 서빙 직전에도 업로드 때와 같은 화이트리스트(png/jpeg/webp/gif)로 다시 한 번 검사한다.
// 업로드 검증이 뚫리거나(과거에 svg가 허용됐던 데이터가 이미 저장돼 있는 경우 등) DB에
// 다른 값이 들어있더라도, 여기서 막으면 신뢰할 수 없는 MIME이 Content-Type으로 그대로
// 반사되어 브라우저에서 실행되는 걸(저장형 XSS) 막을 수 있다.
function serveBase64Image(dataUrl, res) {
  if (!dataUrl) return res.status(404).end();
  if (!ALLOWED_IMAGE_DATA_URL_RE.test(dataUrl)) return res.status(404).end();

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return res.status(404).end();

  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');

  res.set('Content-Type', mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', 'inline');
  // helmet 기본값(Cross-Origin-Resource-Policy: same-origin) 때문에 앱 화면(다른 도메인)의 <img>에서
  // 이 사진들이 차단될 수 있어서, 이미지 응답만 다른 도메인에서도 쓸 수 있게 풀어줌
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
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

module.exports = { getUserAvatar, getUserReviewAvatar, serveBase64Image };
