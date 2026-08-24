const prisma = require('../lib/prisma');

// GET /api/users/:userId/avatar
// 프로필 사진을 base64 문자열이 아니라 진짜 이미지 파일처럼 서빙함 - 이러면 브라우저가 한 번 받은 뒤
// 캐싱해두고 재사용해서, 친구/채팅 목록을 열 때마다 사진을 통째로 다시 받아오지 않아도 됨.
// 로그인 없이도 볼 수 있게(공개) 열어둠 - <img> 태그는 인증 헤더를 못 보내기 때문
async function getUserAvatar(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { profileImageUrl: true },
  });
  if (!user || !user.profileImageUrl) {
    return res.status(404).end();
  }

  const match = user.profileImageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return res.status(404).end();

  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');

  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=604800, immutable'); // 1주일 동안 브라우저가 다시 안 물어보고 캐시 그대로 씀
  return res.send(buffer);
}

module.exports = { getUserAvatar };
