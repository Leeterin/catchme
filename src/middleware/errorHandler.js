// 라우터에서 처리하지 못하고 넘어온 에러를 최종적으로 받아 응답하는 미들웨어
function errorHandler(err, req, res, next) {
  console.error('[unhandled error]', err);
  res.status(500).json({ message: '서버에서 예상치 못한 오류가 발생했어요.' });
}

function notFoundHandler(req, res) {
  res.status(404).json({ message: '요청한 경로를 찾을 수 없어요.' });
}

module.exports = { errorHandler, notFoundHandler };
