const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { getIo } = require('../lib/socket');
const { pushInBackground } = require('../lib/push');
const { hasConfirmedAppointmentOverlap } = require('../lib/bookable');
const { clearAvailabilityInRange, restoreAvailabilityInRange } = require('./chats.controller');

// 약속 초대 링크 - 만든 사람(회원)이 날짜/시간 범위를 정해 링크를 만들고,
// 링크를 받은 사람은 회원가입 없이 이름 + 가능한 1시간 칸을 골라 제출함.
// 칸 표기는 "YYYY-MM-DD|HH" (한국 시간 기준, HH는 그 칸의 시작 시각)

const MAX_DATES = 14;
const MAX_RESPONSES = 50;
const MAX_TITLE = 60;
const MAX_NAME = 20;

function notifyUser(userId, event, payload) {
  const io = getIo();
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00+09:00`);
  return !Number.isNaN(d.getTime());
}

// "2026-10-10", 14 -> 한국 시간 2026-10-10 14:00 의 Date
function kstDate(dateStr, hour) {
  return new Date(new Date(`${dateStr}T00:00:00+09:00`).getTime() + hour * 3600000);
}

function todayKstStr() {
  const now = new Date(Date.now() + 9 * 3600000);
  return now.toISOString().slice(0, 10);
}

function validCellSet(poll, openCells) {
  const set = new Set();
  poll.dates.forEach((d) => {
    for (let h = poll.startHour; h < poll.endHour; h++) set.add(`${d}|${pad2(h)}`);
  });
  if (!openCells) return set;
  return new Set([...set].filter((c) => openCells.has(c)));
}

// "16:45" -> 1005 (5분 단위만, 0~1440)
function parseHm(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v % 5 === 0 && v <= 1440 ? v : null;
}

// 분 단위 가능 시간 "YYYY-MM-DD|HH:MM|HH:MM" 들 중, 고른 칸(cells) 안에 들어가는 것만 남김
function cleanRanges(raw, cells) {
  const cellSet = new Set(cells);
  const out = new Set();
  (Array.isArray(raw) ? raw : []).slice(0, 400).forEach((r) => {
    const [date, a, b] = String(r).split('|');
    const s = parseHm(a);
    const e = parseHm(b);
    if (!isValidDateStr(date) || s === null || e === null || s >= e) return;
    for (let h = Math.floor(s / 60); h < Math.ceil(e / 60); h++) {
      if (!cellSet.has(`${date}|${pad2(h)}`)) return;
    }
    out.add(`${date}|${a}|${b}`);
  });
  return [...out].sort();
}

function addDaysStr(dateStr, n) {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

// 한국 시간 기준 그 시각의 "하루 중 몇 분"
function kstMinuteOfDay(d) {
  const k = new Date(d.getTime() + 9 * 3600000);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}

// 이 사람 캘린더에서 "예약 가능"으로 등록된 1시간 칸들 ("YYYY-MM-DD|HH" Set)
// - 예약 가능 일정이 그 1시간을 빈틈없이 덮어야 하고, 바쁨(약속/예약중) 일정과 겹치면 뺌
// - 이미 지난 시간도 뺌
async function availableCellsFor(userId, dates, startHour = 0, endHour = 24) {
  const cells = new Set();
  if (!dates.length) return cells;
  const sorted = [...dates].sort();
  const rangeStart = kstDate(sorted[0], 0);
  const rangeEnd = kstDate(sorted[sorted.length - 1], 24);
  const events = await prisma.event.findMany({
    where: {
      userId,
      status: { in: ['BUSY', 'AVAILABLE'] },
      OR: [
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lt: rangeEnd },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: rangeStart } }],
        },
      ],
    },
    select: { startTime: true, endTime: true, status: true, recurringWeekdays: true, recurringUntil: true, recurringExceptions: true },
  });

  const now = Date.now();
  sorted.forEach((date) => {
    const dayStart = kstDate(date, 0);
    const dayEnd = kstDate(date, 24);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const avail = [];
    const busy = [];
    events.forEach((ev) => {
      let s = ev.startTime.getTime();
      let e = ev.endTime.getTime();
      if (ev.recurringWeekdays.length > 0) {
        // 반복 일정 - 이 날짜에 해당하면 시:분은 그대로 두고 날짜만 이 날로 옮김
        if (!ev.recurringWeekdays.includes(dow)) return;
        if (ev.recurringExceptions.includes(date)) return;
        if (ev.recurringUntil && dayStart > new Date(ev.recurringUntil)) return;
        if (ev.startTime >= dayEnd) return; // 아직 반복이 시작되기 전 날짜
        const dur = e - s;
        s = dayStart.getTime() + kstMinuteOfDay(ev.startTime) * 60000;
        e = s + dur;
      }
      if (s >= dayEnd.getTime() || e <= dayStart.getTime()) return;
      (ev.status === 'AVAILABLE' ? avail : busy).push([s, e]);
    });
    if (!avail.length) return;
    avail.sort((a, b) => a[0] - b[0]);
    // 붙어있는 예약 가능 조각은 하나로 합침 (14~15시 + 15~16시 = 14~16시)
    const merged = [];
    avail.forEach(([s, e]) => {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    });
    for (let h = startHour; h < endHour; h++) {
      const cs = dayStart.getTime() + h * 3600000;
      const ce = cs + 3600000;
      if (cs < now) continue;
      if (!merged.some(([s, e]) => s <= cs && e >= ce)) continue;
      if (busy.some(([s, e]) => s < ce && e > cs)) continue;
      cells.add(`${date}|${pad2(h)}`);
    }
  });
  return cells;
}

// 캘린더 기준 링크면 지금 열려있는 칸들, 아니면 null(범위 안 전부 가능)
async function openCellsForPoll(poll) {
  if (!poll.fromCalendar || poll.status !== 'OPEN') return null;
  return availableCellsFor(poll.creatorId, poll.dates, poll.startHour, poll.endHour);
}

// 비회원은 브라우저에 저장해둔 guestKey로 자기 응답을 찾음. 회원은 userId로도 찾음
function findMyResponse(poll, { userId, guestKey }) {
  const responses = poll.responses || [];
  if (guestKey) {
    const byKey = responses.find((r) => r.guestKey === guestKey);
    if (byKey) return byKey;
  }
  if (userId) return responses.find((r) => r.userId === userId) || null;
  return null;
}

function serializePoll(poll, { userId, guestKey, openCells } = {}) {
  const mine = findMyResponse(poll, { userId, guestKey });
  return {
    token: poll.token,
    title: poll.title,
    creator: poll.creator ? { name: poll.creator.name, username: poll.creator.username } : null,
    dates: poll.dates,
    startHour: poll.startHour,
    endHour: poll.endHour,
    fromCalendar: poll.fromCalendar,
    place: poll.placeName
      ? { name: poll.placeName, address: poll.placeAddress || '', lat: poll.placeLat, lon: poll.placeLon }
      : null,
    // 캘린더 기준 링크: 지금 고를 수 있는 칸 (만든 사람의 예약 가능 시간). null이면 범위 안 전부
    openCells: openCells ? [...openCells].sort() : null,
    status: poll.status,
    confirmedStart: poll.confirmedStart,
    confirmedEnd: poll.confirmedEnd,
    isCreator: !!userId && poll.creatorId === userId,
    // guestKey/userId는 절대 내보내지 않음 - 이름과 고른 칸만
    responses: (poll.responses || []).map((r) => ({
      name: r.name,
      cells: r.cells,
      ranges: r.ranges || [],
      isMember: !!r.userId,
      mine: !!mine && r.id === mine.id,
    })),
    myResponse: mine ? { name: mine.name, cells: mine.cells, ranges: mine.ranges || [] } : null,
    createdAt: poll.createdAt,
  };
}

const POLL_INCLUDE = {
  creator: { select: { id: true, name: true, username: true } },
  responses: { orderBy: { createdAt: 'asc' } },
};

async function findPollByToken(token) {
  if (typeof token !== 'string' || token.length > 64) return null;
  return prisma.invitePoll.findUnique({ where: { token }, include: POLL_INCLUDE });
}

function confirmedEventTitle(poll) {
  const base = poll.title.length > 40 ? poll.title.slice(0, 40) : poll.title;
  return poll.placeName ? `${base} @ ${poll.placeName}`.slice(0, 80) : base;
}

// { name, address, lat, lon } -> 저장할 값 (이름이 없으면 장소 없음)
function parsePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 60);
  if (!name) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const hasCoords = raw.lat !== null && raw.lon !== null && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    placeName: name,
    placeAddress: String(raw.address || '').trim().slice(0, 120) || null,
    placeLat: hasCoords ? lat : null,
    placeLon: hasCoords ? lon : null,
  };
}

// 확정된 약속을 이 사람 캘린더에 넣음 (같은 시간/제목으로 이미 있으면 다시 만들지 않음)
async function addConfirmedEvent(db, poll, userId) {
  if (!poll.confirmedStart || !poll.confirmedEnd) return;
  const title = confirmedEventTitle(poll);
  const exists = await db.event.findFirst({
    where: { userId, startTime: poll.confirmedStart, endTime: poll.confirmedEnd, title },
    select: { id: true },
  });
  if (exists) return;
  await db.event.create({
    data: {
      userId,
      startTime: poll.confirmedStart,
      endTime: poll.confirmedEnd,
      title,
      status: 'BUSY',
      visibleGroupIds: [],
      visiblePrivate: true,
    },
  });
}

// GET /api/invites/availability - 링크 만들기 화면 미리보기용, 오늘부터 3주 동안 내 예약 가능 칸
async function myAvailability(req, res) {
  try {
    const today = todayKstStr();
    const dates = [];
    for (let i = 0; i < 21; i++) dates.push(addDaysStr(today, i));
    const cells = await availableCellsFor(req.userId, dates);
    const byDate = {};
    [...cells].sort().forEach((c) => {
      const [d, h] = c.split('|');
      (byDate[d] = byDate[d] || []).push(Number(h));
    });
    res.json({ days: Object.keys(byDate).sort().map((date) => ({ date, hours: byDate[date] })) });
  } catch (err) {
    console.error('[myAvailability]', err);
    res.status(500).json({ message: '예약 가능 시간을 불러오지 못했어요.' });
  }
}

// POST /api/invites  { title, dates: ["YYYY-MM-DD"], startHour, endHour, fromCalendar, place? }
// fromCalendar면 startHour/endHour는 무시하고, 고른 날짜들의 내 예약 가능 시간으로 범위를 정함
async function createInvite(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, MAX_TITLE);
    const rawDates = Array.isArray(req.body.dates) ? req.body.dates : [];
    const fromCalendar = req.body.fromCalendar === true;
    let startHour = parseInt(req.body.startHour, 10);
    let endHour = parseInt(req.body.endHour, 10);

    if (!title) return res.status(400).json({ message: '약속 이름을 적어주세요.' });
    let dates = [...new Set(rawDates.filter(isValidDateStr))].sort();
    if (fromCalendar && dates.length > 0 && dates.length <= MAX_DATES) {
      const cells = [...await availableCellsFor(req.userId, dates)];
      if (cells.length === 0) {
        return res.status(400).json({ message: '고른 날짜에 예약 가능한 시간이 없어요. 캘린더에서 먼저 등록해주세요.' });
      }
      const hours = cells.map((c) => Number(c.split('|')[1]));
      startHour = Math.min(...hours);
      endHour = Math.max(...hours) + 1;
      const withCells = new Set(cells.map((c) => c.split('|')[0]));
      dates = dates.filter((d) => withCells.has(d));
    }
    if (dates.length === 0) return res.status(400).json({ message: '날짜를 하나 이상 골라주세요.' });
    if (dates.length > MAX_DATES) return res.status(400).json({ message: `날짜는 최대 ${MAX_DATES}개까지 고를 수 있어요.` });
    if (dates[0] < todayKstStr()) return res.status(400).json({ message: '지난 날짜는 고를 수 없어요.' });
    if (!(startHour >= 0 && startHour <= 23 && endHour >= 1 && endHour <= 24 && startHour < endHour)) {
      return res.status(400).json({ message: '시간 범위가 올바르지 않아요.' });
    }

    const poll = await prisma.invitePoll.create({
      data: {
        token: crypto.randomBytes(9).toString('base64url'),
        creatorId: req.userId,
        title,
        dates,
        startHour,
        endHour,
        fromCalendar,
        ...(parsePlace(req.body.place) || {}),
      },
      include: POLL_INCLUDE,
    });
    res.status(201).json({ invite: serializePoll(poll, { userId: req.userId, openCells: await openCellsForPoll(poll) }) });
  } catch (err) {
    console.error('[createInvite]', err);
    res.status(500).json({ message: '초대 링크를 만들지 못했어요.' });
  }
}

// GET /api/invites - 내가 만든 초대 목록 (최근 것부터)
async function listMyInvites(req, res) {
  try {
    const polls = await prisma.invitePoll.findMany({
      where: { creatorId: req.userId },
      include: POLL_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    res.json({ invites: polls.map((p) => serializePoll(p, { userId: req.userId })) });
  } catch (err) {
    console.error('[listMyInvites]', err);
    res.status(500).json({ message: '초대 목록을 불러오지 못했어요.' });
  }
}

// GET /api/invites/:token?guestKey=  (로그인 없이도 볼 수 있음)
async function getInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '초대 링크를 찾을 수 없어요.' });
    const guestKey = typeof req.query.guestKey === 'string' ? req.query.guestKey.slice(0, 64) : null;
    res.json({ invite: serializePoll(poll, { userId: req.userId, guestKey, openCells: await openCellsForPoll(poll) }) });
  } catch (err) {
    console.error('[getInvite]', err);
    res.status(500).json({ message: '초대 정보를 불러오지 못했어요.' });
  }
}

// POST /api/invites/:token/respond  { guestKey, name, cells, ranges? }  (로그인 없이도 가능)
// ranges는 분 단위로 맞춘 시간 (예: 16시 칸을 골랐지만 실제로는 16:45부터) - 없으면 칸 그대로
async function respondInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '초대 링크를 찾을 수 없어요.' });
    if (poll.status !== 'OPEN') {
      return res.status(409).json({ message: poll.status === 'CONFIRMED' ? '이미 시간이 확정된 약속이에요.' : '취소된 약속이에요.' });
    }
    if (req.userId && poll.creatorId === req.userId) {
      return res.status(400).json({ message: '내가 만든 약속이에요. 친구들의 응답을 기다려주세요.' });
    }

    const guestKey = String(req.body.guestKey || '').trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(guestKey)) return res.status(400).json({ message: '잘못된 요청이에요.' });
    const name = String(req.body.name || '').trim().slice(0, MAX_NAME);
    if (!name) return res.status(400).json({ message: '이름을 적어주세요.' });

    const openCells = await openCellsForPoll(poll);
    const valid = validCellSet(poll, openCells);
    const cells = [...new Set(Array.isArray(req.body.cells) ? req.body.cells : [])].filter((c) => valid.has(c)).sort();
    if (cells.length === 0) {
      return res.status(400).json({ message: openCells ? '고른 시간이 이제 안 돼요. 다시 골라주세요.' : '가능한 시간을 하나 이상 골라주세요.' });
    }

    const ranges = cleanRanges(req.body.ranges, cells);

    const existing = findMyResponse(poll, { userId: req.userId, guestKey });
    if (!existing && poll.responses.length >= MAX_RESPONSES) {
      return res.status(400).json({ message: '응답 인원이 가득 찼어요.' });
    }

    if (existing) {
      await prisma.inviteResponse.update({
        where: { id: existing.id },
        data: { name, cells, ranges, ...(req.userId && !existing.userId ? { userId: req.userId } : {}) },
      });
    } else {
      await prisma.inviteResponse.create({
        data: { pollId: poll.id, guestKey, name, cells, ranges, userId: req.userId || null },
      });
    }

    const updated = await findPollByToken(poll.token);
    notifyUser(poll.creatorId, 'inviteUpdated', {
      token: poll.token,
      title: poll.title,
      name,
      kind: existing ? 'edited' : 'responded',
    });
    res.json({ invite: serializePoll(updated, { userId: req.userId, guestKey, openCells }) });
  } catch (err) {
    console.error('[respondInvite]', err);
    res.status(500).json({ message: '응답을 저장하지 못했어요.' });
  }
}

// POST /api/invites/:token/confirm  { date, startHour, endHour, startMin?, endMin? }  (만든 사람만)
// startMin/endMin(하루 중 몇 분, 5분 단위)이 있으면 그걸로 확정 (예: 16:45~19:00)
async function confirmInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '초대 링크를 찾을 수 없어요.' });
    if (poll.creatorId !== req.userId) return res.status(403).json({ message: '약속을 만든 사람만 확정할 수 있어요.' });
    if (poll.status !== 'OPEN') return res.status(409).json({ message: '이미 확정됐거나 취소된 약속이에요.' });

    const date = String(req.body.date || '');
    const startHour = parseInt(req.body.startHour, 10);
    const endHour = parseInt(req.body.endHour, 10);
    const hasMin = req.body.startMin !== undefined && req.body.endMin !== undefined;
    const startMin = hasMin ? parseInt(req.body.startMin, 10) : startHour * 60;
    const endMin = hasMin ? parseInt(req.body.endMin, 10) : endHour * 60;
    if (!poll.dates.includes(date)) return res.status(400).json({ message: '후보에 없는 날짜예요.' });
    if (!(startMin % 5 === 0 && endMin % 5 === 0 && startMin >= poll.startHour * 60 && endMin <= poll.endHour * 60 && startMin < endMin)) {
      return res.status(400).json({ message: '시간 범위가 올바르지 않아요.' });
    }

    const confirmedStart = kstDate(date, startMin / 60);
    const confirmedEnd = kstDate(date, endMin / 60);
    if (confirmedStart.getTime() < Date.now()) {
      return res.status(400).json({ message: '이미 지난 시간으로는 확정할 수 없어요.' });
    }
    if (await hasConfirmedAppointmentOverlap([req.userId], confirmedStart, confirmedEnd)) {
      return res.status(409).json({ message: '이 시간에 이미 확정된 다른 약속이 있어요.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.invitePoll.updateMany({
        where: { id: poll.id, status: 'OPEN' },
        data: { status: 'CONFIRMED', confirmedStart, confirmedEnd },
      });
      if (changed.count === 0) return null;
      const confirmed = { ...poll, confirmedStart, confirmedEnd };
      const memberIds = [...new Set([poll.creatorId, ...poll.responses.filter((r) => r.userId).map((r) => r.userId)])];
      // 채팅에서 확정할 때처럼, 확정된 시간과 겹치는 "예약 가능" 표시는 정리 (같은 시간에 "예약 가능"이랑 "약속"이 같이 남지 않게)
      await clearAvailabilityInRange(memberIds, confirmedStart, confirmedEnd, tx);
      for (const uid of memberIds) await addConfirmedEvent(tx, confirmed, uid);
      return memberIds;
    });
    if (!result) return res.status(409).json({ message: '이미 확정됐거나 취소된 약속이에요.' });

    result.filter((uid) => uid !== req.userId).forEach((uid) => {
      notifyUser(uid, 'inviteUpdated', { token: poll.token, title: poll.title, kind: 'confirmed' });
    });
    pushInBackground(result.filter((uid) => uid !== req.userId), {
      title: 'CATCHME',
      body: `'${poll.title}' 약속이 확정됐어요!`,
      data: { type: 'invite', token: poll.token },
    });

    const updated = await findPollByToken(poll.token);
    res.json({ invite: serializePoll(updated, { userId: req.userId }) });
  } catch (err) {
    console.error('[confirmInvite]', err);
    res.status(500).json({ message: '약속을 확정하지 못했어요.' });
  }
}

// POST /api/invites/:token/cancel  (만든 사람만)
// 응답 받는 중이면 그냥 닫고, 이미 확정된 약속이면 모두의 캘린더에서 지우고 회원 참여자에게 알림
async function cancelInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '초대 링크를 찾을 수 없어요.' });
    if (poll.creatorId !== req.userId) return res.status(403).json({ message: '약속을 만든 사람만 취소할 수 있어요.' });
    if (poll.status === 'CANCELLED') return res.status(409).json({ message: '이미 취소된 약속이에요.' });

    let notifyIds = [];
    if (poll.status === 'CONFIRMED') {
      const memberIds = [...new Set([poll.creatorId, ...poll.responses.filter((r) => r.userId).map((r) => r.userId)])];
      const title = confirmedEventTitle(poll);
      const done = await prisma.$transaction(async (tx) => {
        const changed = await tx.invitePoll.updateMany({ where: { id: poll.id, status: 'CONFIRMED' }, data: { status: 'CANCELLED' } });
        if (changed.count === 0) return false;
        // 확정할 때 addConfirmedEvent로 만든 일정(같은 사람·시간·제목)을 지우고, 원래 열어둔 시간이었으면 다시 예약 가능으로 복원
        await tx.event.deleteMany({
          where: { userId: { in: memberIds }, startTime: poll.confirmedStart, endTime: poll.confirmedEnd, title, sourceMessageId: null },
        });
        for (const uid of memberIds) {
          await restoreAvailabilityInRange(uid, poll.confirmedStart, poll.confirmedEnd, tx);
        }
        return true;
      });
      if (!done) return res.status(409).json({ message: '이미 취소된 약속이에요.' });
      notifyIds = memberIds.filter((uid) => uid !== req.userId);
    } else {
      const changed = await prisma.invitePoll.updateMany({ where: { id: poll.id, status: 'OPEN' }, data: { status: 'CANCELLED' } });
      if (changed.count === 0) return res.status(409).json({ message: '이미 확정됐거나 취소된 약속이에요.' });
    }

    notifyIds.forEach((uid) => notifyUser(uid, 'inviteUpdated', { token: poll.token, title: poll.title, kind: 'cancelled' }));
    if (notifyIds.length) {
      pushInBackground(notifyIds, {
        title: 'CATCHME',
        body: `'${poll.title}' 약속이 취소됐어요`,
        data: { type: 'invite', token: poll.token },
      });
    }
    const updated = await findPollByToken(poll.token);
    res.json({ invite: serializePoll(updated, { userId: req.userId }) });
  } catch (err) {
    console.error('[cancelInvite]', err);
    res.status(500).json({ message: '약속을 취소하지 못했어요.' });
  }
}

// POST /api/invites/:token/claim  { guestKey }  (로그인 필요)
// 비회원으로 응답했던 사람이 가입/로그인한 뒤, 그 응답을 내 계정에 연결하고 확정된 약속을 내 캘린더에 넣음
async function claimInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '초대 링크를 찾을 수 없어요.' });
    const guestKey = String(req.body.guestKey || '').slice(0, 64);
    const mine = findMyResponse(poll, { userId: req.userId, guestKey });
    if (!mine) return res.status(404).json({ message: '이 약속에 응답한 기록이 없어요.' });
    if (mine.userId && mine.userId !== req.userId) return res.status(403).json({ message: '다른 계정에 연결된 응답이에요.' });

    if (!mine.userId) {
      await prisma.inviteResponse.update({ where: { id: mine.id }, data: { userId: req.userId } });
    }
    let addedToCalendar = false;
    if (poll.status === 'CONFIRMED' && poll.creatorId !== req.userId) {
      await addConfirmedEvent(prisma, poll, req.userId);
      addedToCalendar = true;
    }
    const updated = await findPollByToken(poll.token);
    res.json({ invite: serializePoll(updated, { userId: req.userId, guestKey, openCells: await openCellsForPoll(updated) }), addedToCalendar });
  } catch (err) {
    console.error('[claimInvite]', err);
    res.status(500).json({ message: '약속을 내 계정에 연결하지 못했어요.' });
  }
}

module.exports = {
  myAvailability,
  createInvite,
  listMyInvites,
  getInvite,
  respondInvite,
  confirmInvite,
  cancelInvite,
  claimInvite,
};
