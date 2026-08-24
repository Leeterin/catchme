const jwt = require('jsonwebtoken');

// Authorization: Bearer <token> 헤더를 검증해서 req.userId에 심어준다.
// 아직 "로그인 유지"까지 다듬은 건 아니고, 친구 API가 동작하려면
// 최소한 "지금 요청한 사람이 누구인지"는 있어야 해서 넣은 기본 버전.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: '로그인이 필요해요.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ message: '로그인이 만료됐어요. 다시 로그인해주세요.' });
  }
}

module.exports = { requireAuth };
