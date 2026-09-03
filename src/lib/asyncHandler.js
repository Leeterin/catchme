// async 라우트 핸들러를 감싸는 유틸 - Express 4는 async 함수 안에서 던진(reject된) 에러를
// 자동으로 next(err)로 넘겨주지 않아서, 감싸지 않은 핸들러는 DB 에러 하나에도 처리되지 않은
// Promise rejection이 되어 요청이 그냥 멈추거나(응답 없음) 최악의 경우 서버 프로세스가 죽을 수 있다.
// 모든 라우트 등록을 이걸로 감싸서, 에러가 나면 항상 errorHandler 미들웨어로 넘어가게 만든다.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
