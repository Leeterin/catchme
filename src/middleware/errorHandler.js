// 라우터에서 처리하지 못하고 넘어온 에러를 최종적으로 받아 응답하는 미들웨어
function errorHandler(err, req, res, next) {
  // 이미 응답을 보낸 뒤에 난 에러면 Express 기본 처리로 넘김 (응답을 두 번 보내면 또 에러가 남)
  if (res.headersSent) return next(err);
  // 두 번 누르기·동시에 처리하기에서 흔히 나는 DB 에러는 500 대신 상황에 맞게 알려줌
  // P2025: 지우거나 바꾸려는 게 이미 없음 (먼저 온 요청이 지웠음)
  if (err && err.code === 'P2025') {
    return res.status(404).json({ message: '이미 삭제됐거나 없는 항목이에요.' });
  }
  // P2002: 같은 게 이미 있음 (먼저 온 요청이 만들었음)
  if (err && err.code === 'P2002') {
    return res.status(409).json({ message: '이미 처리된 요청이에요.' });
  }
  console.error('[unhandled error]', err);
  res.status(500).json({ message: '서버에서 예상치 못한 오류가 발생했어요.' });
}

function notFoundHandler(req, res) {
  res.status(404).json({ message: '요청한 경로를 찾을 수 없어요.' });
}

module.exports = { errorHandler, notFoundHandler };
