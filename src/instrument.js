// Sentry 에러 모니터링 초기화.
// SENTRY_DSN 환경변수가 아직 없으면(로컬 개발, DSN 설정 전 배포 등) 그냥 아무 것도 안 하고 넘어감 - 안전한 기본값.
// 이 파일은 반드시 server.js의 다른 모든 require(특히 express)보다 먼저 불러와야 함 -
// Sentry가 express/http 등을 자동으로 계측(instrument)하려면 그 모듈들이 require되기 전에 초기화가 끝나 있어야 하기 때문.
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1, // 성능 트레이싱은 가볍게 10%만 수집 (무료 플랜 쿼터 절약 목적)
  });
  console.log('[Sentry] 에러 모니터링 활성화됨');
}
