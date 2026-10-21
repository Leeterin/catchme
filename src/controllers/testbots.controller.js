// 테스트 친구(봇) - 혼자서 1:1·다인원 약속 흐름을 일반 채팅과 똑같이 확인하려고 만드는 내 계정 전용 가짜 친구 3명.
// 진짜 계정·친구·채팅방이라 모든 기능이 일반 친구와 같은 코드로 돌아가고, 봇은 서버에서 알아서 반응함:
//  - 약속 요청·날짜 물어보기를 받으면 바로 수락
//  - 내가 시간 후보·장소 후보에 투표하면 같은 곳에 투표 (1:1 시간 후보는 첫 번째를 고름)
// 봇은 이메일이 BOT_DOMAIN으로 끝나는 계정으로 구분하고(스키마 변경 없음), 아이디 검색엔 안 나옴.
const prisma = require('../lib/prisma');
const chats = require('./chats.controller');

const BOT_DOMAIN = '@testbot.meetzip.invalid';
const BOT_COUNT = 3;
const BOT_DELAY_MS = 1500; // 사람처럼 잠깐 있다가 반응

const isBotEmail = (email) => typeof email === 'string' && email.endsWith(BOT_DOMAIN);
const botEmail = (ownerId, n) => `${ownerId}.${n}${BOT_DOMAIN}`;

// 컨트롤러를 봇 계정으로 그대로 실행 (요청/응답 흉내) - 일반 사용자가 누른 것과 똑같이 처리됨
async function runAs(handler, userId, { params = {}, body = {}, query = {} } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ userId, params, body, query }, res);
  if (res.statusCode >= 400) console.warn('[testbots]', handler.name, res.statusCode, res.body && res.body.message);
  return res;
}
const later = (fn) => setTimeout(() => { fn().catch((err) => console.error('[testbots]', err.message)); }, BOT_DELAY_MS);

// 이 방의 봇 멤버 id들
async function botIdsInRoom(chatRoomId) {
  const members = await prisma.chatRoomMember.findMany({
    where: { chatRoomId },
    select: { userId: true, user: { select: { email: true } } },
  });
  return members.filter((m) => isBotEmail(m.user.email)).map((m) => m.userId);
}
async function isBot(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return !!u && isBotEmail(u.email);
}

// 응답(JSON)이 나간 뒤에 봇 반응을 붙이는 래퍼 - 원래 처리는 전혀 안 바뀜. 봇이 한 행동엔 다시 반응하지 않음
function withBotReaction(handler, react) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      const out = json(body);
      if (res.statusCode < 400) {
        Promise.resolve().then(async () => {
          if (await isBot(req.userId)) return;
          await react(req, body);
        }).catch((err) => console.error('[testbots]', err.message));
      }
      return out;
    };
    return handler(req, res, next);
  };
}

// 약속 요청을 봇이 받으면 수락
const onReservationSent = (req, body) => {
  const m = body && body.message;
  if (!m) return;
  return botIdsInRoom(req.params.roomId).then((bots) => bots.forEach((botId) => later(() =>
    runAs(chats.acceptReservation, botId, { params: { messageId: m.id } }))));
};
// 날짜 물어보기도 수락
const onDateAskSent = (req, body) => {
  const m = body && body.message;
  if (!m) return;
  return botIdsInRoom(req.params.roomId).then((bots) => bots.slice(0, 1).forEach((botId) => later(() =>
    runAs(chats.respondDateAsk, botId, { params: { messageId: m.id }, body: { action: 'accept' } }))));
};
// 1:1 시간 후보는 상대가 하나를 고르는 방식이라 봇이 첫 번째를 고름 (그룹은 내가 투표하면 따라 투표)
const onTimeProposalSent = async (req, body) => {
  const m = body && body.message;
  if (!m) return;
  const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId }, select: { isGroup: true } });
  if (!room || room.isGroup) return;
  const option = await prisma.timeProposalOption.findFirst({ where: { messageId: m.id }, orderBy: { startTime: 'asc' } }); // 가장 이른 후보
  if (!option) return;
  const bots = await botIdsInRoom(req.params.roomId);
  bots.forEach((botId) => later(() => runAs(chats.voteTimeProposal, botId, { params: { messageId: m.id }, body: { optionId: option.id } })));
};
// 내가 시간 후보에 투표하면 봇들도 같은 후보에
const onTimeVoted = async (req) => {
  const message = await prisma.message.findUnique({ where: { id: req.params.messageId }, select: { chatRoomId: true } });
  if (!message) return;
  const bots = await botIdsInRoom(message.chatRoomId);
  bots.forEach((botId, i) => setTimeout(() => {
    runAs(chats.voteTimeProposal, botId, { params: { messageId: req.params.messageId }, body: { optionId: req.body.optionId } })
      .catch((err) => console.error('[testbots]', err.message));
  }, BOT_DELAY_MS * (i + 1)));
};
// 내가 장소 후보에 투표하면 봇들도 같은 곳에 (투표는 누르면 켜고/끄는 방식이라 이미 그곳에 투표했으면 안 누름)
const onLocationVoted = async (req) => {
  const messageId = req.params.messageId;
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { chatRoomId: true } });
  if (!message) return;
  const mine = await prisma.locationSuggestVote.findUnique({ where: { messageId_userId: { messageId, userId: req.userId } } });
  if (!mine) return; // 내가 투표를 취소한 거면 따라 하지 않음
  const bots = await botIdsInRoom(message.chatRoomId);
  bots.forEach((botId, i) => setTimeout(async () => {
    try {
      const had = await prisma.locationSuggestVote.findUnique({ where: { messageId_userId: { messageId, userId: botId } } });
      if (!had) await runAs(chats.voteLocationSuggest, botId, { params: { messageId } });
    } catch (err) { console.error('[testbots]', err.message); }
  }, BOT_DELAY_MS * (i + 1)));
};

// 한국 시간 기준 오늘 날짜 "YYYY-MM-DD"
function kstToday() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

// GET /api/testbots - 내 테스트 친구 목록
async function listTestBots(req, res) {
  const bots = await prisma.user.findMany({
    where: { email: { startsWith: `${req.userId}.`, endsWith: BOT_DOMAIN } },
    select: { id: true, username: true, name: true },
    orderBy: { name: 'asc' },
  });
  return res.json({ bots });
}

// POST /api/testbots/setup - 테스트 친구 3명(없는 것만) + 서로 친구 + 매일 9~23시 예약 가능 시간 + 테스트 모임방
async function setupTestBots(req, res) {
  const owner = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, email: true } });
  if (!owner || isBotEmail(owner.email)) return res.status(403).json({ message: '이 계정에선 만들 수 없어요.' });
  const short = owner.id.replace(/-/g, '').slice(0, 6).toLowerCase();
  const today = kstToday();
  const bots = [];
  for (let n = 1; n <= BOT_COUNT; n++) {
    const email = botEmail(owner.id, n);
    // eslint-disable-next-line no-await-in-loop
    let bot = await prisma.user.findUnique({ where: { email } });
    if (!bot) {
      // eslint-disable-next-line no-await-in-loop
      bot = await prisma.user.create({
        data: {
          email, username: `tb${short}${n}`, name: `테스트${n}`, passwordHash: null, // 로그인 못 하는 계정
          settings: { create: { friendSearchAllow: false, notifMessage: false } },
          events: { create: {
            title: '예약 가능', status: 'AVAILABLE', eventType: 'available', availableFor: 'all',
            startTime: new Date(`${today}T09:00:00+09:00`), endTime: new Date(`${today}T23:00:00+09:00`),
            recurringWeekdays: [0, 1, 2, 3, 4, 5, 6],
          } },
        },
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.friendRequest.upsert({
      where: { senderId_receiverId: { senderId: owner.id, receiverId: bot.id } },
      update: { status: 'ACCEPTED', respondedAt: new Date() },
      create: { senderId: owner.id, receiverId: bot.id, status: 'ACCEPTED', respondedAt: new Date() },
    });
    bots.push(bot);
  }
  // 테스트 모임방 (나 + 테스트 친구 3명) - 이미 있으면 그대로
  const existing = await prisma.chatRoom.findFirst({
    where: { isGroup: true, name: '🧪 테스트 모임', members: { some: { userId: owner.id } } },
    select: { id: true },
  });
  let groupRoomId = existing && existing.id;
  if (!groupRoomId) {
    const r = await runAs(chats.createGroupRoom, owner.id, { body: { name: '🧪 테스트 모임', usernames: bots.map((b) => b.username) } });
    groupRoomId = r.body && r.body.roomId;
  }
  return res.json({ bots: bots.map((b) => ({ id: b.id, username: b.username, name: b.name })), groupRoomId });
}

// POST /api/testbots/teardown - 테스트 친구와 테스트 친구하고만 있던 방·그 방에서 생긴 내 약속 일정을 전부 지움
async function teardownTestBots(req, res) {
  const bots = await prisma.user.findMany({
    where: { email: { startsWith: `${req.userId}.`, endsWith: BOT_DOMAIN } }, select: { id: true },
  });
  const botIds = new Set(bots.map((b) => b.id));
  if (!botIds.size) return res.json({ deleted: 0 });
  const myRooms = await prisma.chatRoom.findMany({
    where: { members: { some: { userId: req.userId } } },
    select: { id: true, members: { select: { userId: true } } },
  });
  const testRoomIds = myRooms
    .filter((r) => r.members.some((m) => botIds.has(m.userId)) && r.members.every((m) => m.userId === req.userId || botIds.has(m.userId)))
    .map((r) => r.id);
  await prisma.$transaction([
    prisma.event.deleteMany({ where: { userId: req.userId, sourceChatRoomId: { in: testRoomIds } } }),
    prisma.chatRoom.deleteMany({ where: { id: { in: testRoomIds } } }),
    prisma.user.deleteMany({ where: { id: { in: [...botIds] } } }),
  ]);
  return res.json({ deleted: botIds.size, rooms: testRoomIds.length });
}

module.exports = {
  BOT_DOMAIN, isBotEmail, withBotReaction,
  onReservationSent, onDateAskSent, onTimeProposalSent, onTimeVoted, onLocationVoted,
  listTestBots, setupTestBots, teardownTestBots,
};
