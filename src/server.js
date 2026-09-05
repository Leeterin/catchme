// 서버가 어느 나라 클라우드에서 돌든(보통 UTC) 항상 한국 시간 기준으로 날짜/시간을 계산하게 고정함.
// 이게 없으면 setHours() 같은 "로컬 시간" 함수들이 UTC 기준으로 동작해서,
// 예약가능/매칭 계산에서 시간이 최대 9시간씩 어긋나는 버그가 생김.
process.env.TZ = 'Asia/Seoul';

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

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
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { setIo } = require('./lib/socket');

const app = express();
const httpServer = http.createServer(app);

// 실시간 메시지 전송용 소켓 서버. 프론트엔드가 REST API랑 같은 주소로 접속함.
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// 소켓 연결 시 로그인 토큰(JWT)으로 신원 확인 -> 이 사람 전용 방("user:유저id")에 넣어둠.
// 나중에 새 메시지가 생기면 io.to(`user:상대방id`).emit(...) 으로 그 사람에게만 실시간 전달.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.sub;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
});

setIo(io);

app.use(cors());
app.use(express.json());

// 전체 API에 대한 넓은 안전망 - IP 하나당 1분에 300번 넘게 요청하면 잠깐 막음 (봇/무한루프 방지용, 평소 정상 사용엔 영향 없음)
const rateLimit = require('express-rate-limit');
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' },
}));

// commit(RENDER_GIT_COMMIT)까지 같이 보여줘서, "지금 떠있는 서버가 정확히 어느 커밋인지"를
// 배포 후 매번 다른 기능으로 우회 확인할 필요 없이 이 한 endpoint로 바로 확인할 수 있게 함.
// (Render가 배포할 때마다 이 환경변수를 자동으로 채워줌 - 로컬/다른 호스팅에서는 그냥 없어서 null)
app.get('/health', (req, res) => res.json({ ok: true, commit: process.env.RENDER_GIT_COMMIT || null }));

app.use('/api/auth', authRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/meetups', meetupsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', require('./routes/avatar.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`CATCHME API server listening on http://localhost:${PORT}`);
});
