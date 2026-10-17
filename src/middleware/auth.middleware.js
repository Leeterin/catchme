const jwt = require('jsonwebtoken');
const { markActive } = require('../lib/analytics');

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
    markActive(req.userId); // 오늘 앱을 쓴 날로 기록 (재방문율 지표용, 하루 한 번만 씀)
    next();
  } catch (err) {
    return res.status(401).json({ message: '로그인이 만료됐어요. 다시 로그인해주세요.' });
  }
}

// 로그인 없이도 쓸 수 있는 API용 - 유효한 토큰이 있으면 req.userId를 심고, 없거나 잘못됐으면 비회원으로 그냥 통과
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      req.userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    } catch (err) {
      // 만료/위조 토큰이면 비회원으로 취급
    }
  }
  next();
}

// 로그인 없이도 볼 수 있는 조회용(리뷰 목록 등) - 토큰이 아예 없으면 비회원으로 통과, 토큰이 있으면 requireAuth와 똑같이 검사.
// optionalAuth처럼 만료된 토큰을 비회원으로 넘기면 앱이 토큰을 새로 받지 않아서, 로그인한 사람한테 내 저장 표시가 빠진 채로 보임
function viewerAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return requireAuth(req, res, next);
}

module.exports = { requireAuth, optionalAuth, viewerAuth };
