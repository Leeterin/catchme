// Sentry는 express 등 다른 모듈이 require되기 전에 초기화돼야 자동으로 에러를 잡을 수 있어서
// 반드시 이 파일의 다른 어떤 require보다도 먼저 와야 함. SENTRY_DSN이 없으면 내부적으로 아무 것도 안 함.
require('./instrument');

// 서버가 어느 나라 클라우드에서 돌든(보통 UTC) 항상 한국 시간 기준으로 날짜/시간을 계산하게 고정함.
// 이게 없으면 setHours() 같은 "로컬 시간" 함수들이 UTC 기준으로 동작해서,
// 예약가능/매칭 계산에서 시간이 최대 9시간씩 어긋나는 버그가 생김.
process.env.TZ = 'Asia/Seoul';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const prisma = require('./lib/prisma');

const authRoutes = require('./routes/auth.routes');
const friendsRoutes = require('./routes/friends.routes');
const chatsRoutes = require('./routes/chats.routes');
const eventsRoutes = require('./routes/events.routes');
const placesRoutes = require('./routes/places.routes');
const profileRoutes = require('./routes/profile.routes');
const meetupsRoutes = require('./routes/meetups.routes');
const settingsRoutes = require('./routes/settings.routes');
const feedRoutes = require('./routes/feed.routes');
const reportsRoutes = require('./routes/reports.routes');
const adminRoutes = require('./routes/admin.routes');
const invitesRoutes = require('./routes/invites.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { setIo } = require('./lib/socket');

const app = express();
const httpServer = http.createServer(app);

// CORS 허용 출처 - 원래는 cors()가 모든 출처를 다 허용해서(전면 개방) 아무 사이트에서나
// 이 API를 호출할 수 있었음(2026-09-30 보안 감사 Medium 6번). 프로덕션 프론트 도메인만 허용하도록 제한.
// FRONTEND_URL 환경변수가 있으면 그 값을, 없으면 실제 배포된 프론트 주소를 기본값으로 씀.
// 끝에 슬래시(/)가 붙어있어도(FRONTEND_URL이 OAuth 리다이렉트용으로 이미 쓰이고 있어서
// 그쪽 형식과 다를 수 있음) 비교에서 걸러지도록 항상 슬래시를 떼고 비교함 - 안 떼면 브라우저가
// 보내는 실제 Origin 헤더(끝에 슬래시 없음)와 문자열이 달라져서 정상 프론트가 차단당할 수 있음.
const stripTrailingSlash = (s) => (typeof s === 'string' ? s.replace(/\/+$/, '') : s);
const PROD_FRONTEND_ORIGIN = stripTrailingSlash(process.env.FRONTEND_URL) || 'https://catchme-29rt.onrender.com';
// 관리자 페이지(/admin)는 이 서버 자신이 직접 서빙하는 정적 페이지라 Origin이 백엔드 자신의 주소로 찍힘
// (프론트 도메인이 아님). 같은 출처인데도 브라우저가 POST 요청엔 Origin 헤더를 붙이는 경우가 있어서,
// 이걸 허용 목록에 안 넣으면 관리자 페이지에서의 로그인 요청이 전부 CORS 에러로 500 처리됨.
const BACKEND_SELF_ORIGIN = stripTrailingSlash(process.env.BACKEND_URL) || 'https://catchme-backend-d7vh.onrender.com';
function isAllowedOrigin(origin) {
  if (!origin) return true; // 서버 간 호출, curl, 모바일 앱 등 Origin 헤더 자체가 없는 요청
  if (stripTrailingSlash(origin) === PROD_FRONTEND_ORIGIN) return true;
  if (stripTrailingSlash(origin) === BACKEND_SELF_ORIGIN) return true; // 관리자 페이지(/admin) 자체에서 오는 요청
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true; // 로컬 개발 중 테스트용
  return false;
}
const corsOriginCheck = (origin, callback) => {
  if (isAllowedOrigin(origin)) return callback(null, true);
  // 실제로 어떤 출처가 막혔는지 로그로 남겨서, 예상 못한 값(FRONTEND_URL 오타 등)으로
  // 정상 프론트까지 막히는 경우를 Render 로그에서 바로 확인할 수 있게 함.
  console.warn(`[CORS] 차단된 출처: ${origin} (허용된 값: ${PROD_FRONTEND_ORIGIN})`);
  return callback(new Error('CORS: 허용되지 않은 출처입니다.'));
};

// 실시간 메시지 전송용 소켓 서버. 프론트엔드가 REST API랑 같은 주소로 접속함.
const io = new Server(httpServer, {
  cors: { origin: corsOriginCheck },
});

// 소켓 연결 시 로그인 토큰(JWT)으로 신원 확인 -> 이 사람 전용 방("user:유저id")에 넣어둠.
// 나중에 새 메시지가 생기면 io.to(`user:상대방id`).emit(...) 으로 그 사람에게만 실시간 전달.
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(new Error('unauthorized'));
  }
  try {
    // 탈퇴했거나 정지된 계정은 (토큰이 아직 안 만료됐어도) 실시간 연결을 받지 않음
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isSuspended: true } });
    if (!user || user.isSuspended) return next(new Error('unauthorized'));
  } catch (err) {
    return next(new Error('unavailable'));
  }
  socket.userId = payload.sub;
  return next();
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
});

setIo(io);

// 보안 헤더 - X-Content-Type-Options, X-Frame-Options, CSP 등을 기본값으로 자동 설정 (2026-09-30 보안 감사 Medium 6번)
app.use(helmet());
app.use(cors({ origin: corsOriginCheck }));
// 기본 body 크기 제한(100kb)은 리뷰/채팅 사진(base64, 장당 최대 약 500~700KB, 리뷰는 최대 5장)을 못 담아서
// 사진 있는 요청이 "PayloadTooLargeError"로 튕기고 프론트에는 "서버에서 예상치 못한 오류가 발생했어요"로만 보였음.
// 특히 폰 카메라로 찍은 사진은 디테일이 많아 같은 해상도로 압축해도 컴퓨터 사진보다 용량이 커서 이 한도를 더 잘 넘었음.
app.use(express.json({ limit: '10mb' }));

// Render에서는 요청이 Cloudflare → Render 내부 프록시 → 컨테이너 안 프록시(::1) 3단계를 거쳐 들어옴 (2026-10-04 실제 확인).
// 이 설정이 없으면 req.ip가 모든 사용자에게 똑같이 "::1"이라, 아래 IP별 요청 제한이 사용자 전체에 합쳐서 걸렸음
// (예: 로그인 15분 10번이 "전체 사용자 합쳐서" 10번). 3단계만 믿으면 사용자가 X-Forwarded-For를 위조해도 실제 IP가 잡힘
app.set('trust proxy', 3);

// 전체 API에 대한 넓은 안전망 - IP 하나당 1분에 300번 넘게 요청하면 잠깐 막음 (봇/무한루프 방지용, 평소 정상 사용엔 영향 없음)
const rateLimit = require('express-rate-limit');
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' },
}));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/meetups', meetupsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/push', require('./routes/push.routes'));
app.use('/api/feed', feedRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', require('./routes/avatar.routes'));
// 소식 게시물 사진 - 공개(로그인 없이), 브라우저 캐시용
app.get('/api/feed-photos/:postId/:idx', (req, res, next) => require('./controllers/feed.controller').getFeedPhoto(req, res).catch(next));
// 채팅 사진 - 서명된 주소로만 열림, 브라우저 캐시용
app.get('/api/chat-images/:messageId', (req, res, next) => require('./controllers/chats.controller').getChatImage(req, res).catch(next));
app.use('/api/admin', adminRoutes);
app.use('/api/invites', invitesRoutes);

// 별도 관리자 페이지 - 일반 유저 앱(catchme-F 저장소)과는 완전히 분리된 정적 페이지.
// 이 페이지를 열 수 있다는 것 자체는 누구나 가능하지만, 안의 모든 API 호출은 /api/admin/*
// 이라 위 adminRoutes(requireAuth + requireAdmin)를 통과 못 하면 아무 데이터도 못 봄.
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`CATCHME API server listening on http://localhost:${PORT}`);
});
