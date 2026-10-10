const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { getIo } = require('../lib/socket');
const { pushInBackground } = require('../lib/push');
const { track } = require('../lib/analytics');
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

// 응답 받는 중인데 후보 날짜의 마지막 시간까지 다 지났으면 "마감" - 따로 저장하지 않고 볼 때마다 계산
function isPollExpired(poll) {
  if (poll.status !== 'OPEN' || !poll.dates.length) return false;
  const last = [...poll.dates].sort().pop();
  return kstDate(last, poll.endHour).getTime() <= Date.now();
}

// 이미 끝난 1시간 칸인지 (진행 중인 칸은 아직 고를 수 있음)
function isPastCell(cell) {
  const [d, h] = cell.split('|');
  return kstDate(d, Number(h) + 1).getTime() <= Date.now();
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

// 링크 용도: 친구용은 "모두 + 친구만", 일용은 "모두 + 일만" 열어둔 시간을 씀
// 그룹용("group:<그룹 id>")은 친구에게 연 시간 중 모든 친구 또는 그 그룹에 연 시간만 씀
const AUDIENCES = ['friends', 'work'];
function parseAudience(v) {
  if (typeof v === 'string' && /^group:[0-9a-zA-Z-]{1,64}$/.test(v)) return v;
  return AUDIENCES.includes(v) ? v : 'friends';
}
function audienceGroupId(audience) {
  return typeof audience === 'string' && audience.startsWith('group:') ? audience.slice(6) : null;
}

// 이 사람 캘린더에서 "예약 가능"으로 등록된 1시간 칸들 ("YYYY-MM-DD|HH" Set)
// - 예약 가능 일정이 그 1시간을 빈틈없이 덮어야 하고, 바쁨(약속/예약중) 일정과 겹치면 뺌
// - 링크 용도(audience)에 안 맞게 열어둔 시간(친구용 링크의 "일만", 일용 링크의 "친구만")은 안 씀
// - 이미 지난 시간도 뺌
async function availableCellsFor(userId, dates, startHour = 0, endHour = 24, audience = 'friends') {
  const cells = new Set();
  if (!dates.length) return cells;
  const sorted = [...dates].sort();
  const rangeStart = kstDate(sorted[0], 0);
  const rangeEnd = kstDate(sorted[sorted.length - 1], 24);
  const events = await prisma.event.findMany({
    where: {
      userId,
      status: { in: ['BUSY', 'AVAILABLE'] },
      NOT: { status: 'BUSY', blocksBooking: false }, // "이 시간에도 예약 받기" 켠 바쁨 일정은 예약을 막지 않음
      OR: [
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lt: rangeEnd },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: rangeStart } }],
        },
      ],
    },
    select: { startTime: true, endTime: true, status: true, availableFor: true, visiblePrivate: true, visibleGroupIds: true, recurringWeekdays: true, recurringUntil: true, recurringExceptions: true },
  });
  const groupId = audienceGroupId(audience);
  const forThisLink = groupId
    ? (ev) => ev.availableFor !== 'work' && !ev.visiblePrivate && (ev.visibleGroupIds.length === 0 || ev.visibleGroupIds.includes(groupId))
    : (ev) => ev.availableFor === 'all' || ev.availableFor === audience;

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
      if (ev.status === 'BUSY') busy.push([s, e]);
      else if (forThisLink(ev)) avail.push([s, e]);
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
  // 직접 고르기에서 날짜마다 따로 연 칸 - 링크에 저장된 그대로 (캘린더와 상관없음)
  if (!poll.fromCalendar && poll.manualCells && poll.manualCells.length) return new Set(poll.manualCells);
  if (!poll.fromCalendar || poll.status !== 'OPEN') return null;
  return availableCellsFor(poll.creatorId, poll.dates, poll.startHour, poll.endHour, poll.audience);
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
    audience: poll.audience,
    place: poll.placeName
      ? { name: poll.placeName, address: poll.placeAddress || '', lat: poll.placeLat, lon: poll.placeLon }
      : null,
    // 캘린더 기준 링크: 지금 고를 수 있는 칸 (만든 사람의 예약 가능 시간). null이면 범위 안 전부
    openCells: openCells ? [...openCells].sort() : null,
    status: poll.status,
    expired: isPollExpired(poll),
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

// 일용 링크로 잡힌 약속은 캘린더에서 바로 구분되게 앞에 💼를 붙임
function confirmedEventBaseTitle(poll) {
  const raw = poll.title.length > 40 ? poll.title.slice(0, 40) : poll.title;
  const base = poll.audience === 'work' ? `💼 ${raw}` : raw;
  return poll.placeName ? `${base} @ ${poll.placeName}`.slice(0, 80) : base;
}

// 이 사람 캘린더에 들어갈 제목 - 누구와의 약속인지 앞에 붙임 (예: "민지님과 약속 - 커피 한잔")
// 만든 사람에겐 응답한 사람들 이름, 응답한 사람에겐 만든 사람(+다른 응답자) 이름
function confirmedEventTitle(poll, userId) {
  const base = confirmedEventBaseTitle(poll);
  const others = [];
  if (poll.creatorId !== userId && poll.creator && poll.creator.name) others.push(poll.creator.name);
  (poll.responses || []).forEach((r) => {
    if (userId && r.userId === userId) return;
    if (r.name) others.push(r.name);
  });
  if (others.length === 0) return base;
  // "님"·"명" 모두 받침이 있어서 조사는 항상 "과"
  const who = others.length === 1 ? `${others[0]}님`
    : others.length === 2 ? `${others[0]}님, ${others[1]}님`
      : `${others[0]}님 외 ${others.length - 1}명`;
  return `${who}과 약속 - ${base}`;
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
  const title = confirmedEventTitle(poll, userId);
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

// GET /api/invites/availability?audience=friends|work|group:<id> - 링크 만들기 화면 미리보기용, 오늘부터 3주 동안 내 예약 가능 칸
async function myAvailability(req, res) {
  try {
    const today = todayKstStr();
    const dates = [];
    for (let i = 0; i < 21; i++) dates.push(addDaysStr(today, i));
    const cells = await availableCellsFor(req.userId, dates, 0, 24, parseAudience(req.query.audience));
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

// POST /api/invites  { title, dates: ["YYYY-MM-DD"], startHour, endHour, fromCalendar, cells?, audience?(friends|work|group:<id>), place? }
// fromCalendar면 startHour/endHour는 무시하고, 고른 날짜들의 내 예약 가능 시간으로 범위를 정함
// cells(["YYYY-MM-DD|HH"])가 있으면 직접 고르기 - 날짜마다 따로 연 칸으로 날짜·범위를 정함 (링크에만 저장)
async function createInvite(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, MAX_TITLE);
    const rawDates = Array.isArray(req.body.dates) ? req.body.dates : [];
    const fromCalendar = req.body.fromCalendar === true;
    const audience = parseAudience(req.body.audience);
    let startHour = parseInt(req.body.startHour, 10);
    let endHour = parseInt(req.body.endHour, 10);

    if (!title) return res.status(400).json({ message: '약속 이름을 적어주세요.' });
    let dates = [...new Set(rawDates.filter(isValidDateStr))].sort();
    let manualCells = [];
    if (!fromCalendar && Array.isArray(req.body.cells) && req.body.cells.length) {
      manualCells = [...new Set(req.body.cells.filter((c) => {
        const m = /^(\d{4}-\d{2}-\d{2})\|(\d{2})$/.exec(String(c));
        return m && isValidDateStr(m[1]) && Number(m[2]) <= 23;
      }))].sort();
      if (manualCells.length === 0) return res.status(400).json({ message: '열어둘 시간을 하나 이상 골라주세요.' });
      const hours = manualCells.map((c) => Number(c.split('|')[1]));
      startHour = Math.min(...hours);
      endHour = Math.max(...hours) + 1;
      dates = [...new Set(manualCells.map((c) => c.split('|')[0]))].sort();
    }
    if (fromCalendar && dates.length > 0 && dates.length <= MAX_DATES) {
      const cells = [...await availableCellsFor(req.userId, dates, 0, 24, audience)];
      if (cells.length === 0) {
        return res.status(400).json({
          message: audience === 'work'
            ? '고른 날짜에 업무용으로 열어둔 시간이 없어요. 캘린더에서 "모두"나 "업무용"으로 먼저 열어주세요.'
            : audienceGroupId(audience)
              ? '고른 날짜에 이 그룹에 열어둔 시간이 없어요. 캘린더에서 이 그룹이나 모든 친구에게 먼저 열어주세요.'
              : '고른 날짜에 예약 가능한 시간이 없어요. 캘린더에서 먼저 등록해주세요.',
        });
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
        manualCells,
        audience,
        ...(parsePlace(req.body.place) || {}),
      },
      include: POLL_INCLUDE,
    });
    track(req.userId, 'invite_created', { fromCalendar, audience });
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
    if (!poll) return res.status(404).json({ message: '삭제됐거나 없는 약속 링크예요.' });
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
    if (!poll) return res.status(404).json({ message: '삭제됐거나 없는 약속 링크예요.' });
    if (poll.status !== 'OPEN') {
      return res.status(409).json({ message: poll.status === 'CONFIRMED' ? '이미 시간이 확정된 약속이에요.' : '취소된 약속이에요.' });
    }
    if (isPollExpired(poll)) return res.status(409).json({ message: '날짜가 지나서 마감된 약속이에요.' });
    if (req.userId && poll.creatorId === req.userId) {
      return res.status(400).json({ message: '내가 만든 약속이에요. 친구들의 응답을 기다려주세요.' });
    }

    const guestKey = String(req.body.guestKey || '').trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(guestKey)) return res.status(400).json({ message: '잘못된 요청이에요.' });
    const name = String(req.body.name || '').trim().slice(0, MAX_NAME);
    if (!name) return res.status(400).json({ message: '이름을 적어주세요.' });

    const openCells = await openCellsForPoll(poll);
    const valid = validCellSet(poll, openCells);
    // 이미 지난 칸은 버림 (지난주 시간에 "돼요"가 쌓이지 않게)
    const picked = [...new Set(Array.isArray(req.body.cells) ? req.body.cells : [])];
    const cells = picked.filter((c) => valid.has(c) && !isPastCell(c)).sort();
    if (cells.length === 0) {
      return res.status(400).json({ message: openCells || picked.length ? '고른 시간이 이제 안 돼요. 다시 골라주세요.' : '가능한 시간을 하나 이상 골라주세요.' });
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
    if (!existing) {
      // 링크를 보낸 사람이 앱으로 돌아오는 첫 계기 - 새 응답이 올 때마다 휴대폰 알림 (고친 응답은 조용히)
      const count = updated ? updated.responses.length : 0;
      pushInBackground([poll.creatorId], {
        title: 'CATCHME',
        body: `${name}님이 '${poll.title}'에 되는 시간을 보냈어요${count > 1 ? ` (지금 ${count}명 응답)` : ''}`,
        data: { type: 'invite', token: poll.token },
      });
      track(req.userId || null, 'invite_responded', { guest: !req.userId, creatorId: poll.creatorId });
    }
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
    if (!poll) return res.status(404).json({ message: '삭제됐거나 없는 약속 링크예요.' });
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
    // 캘린더 기준 링크면 지금도 예약 가능으로 열려 있는 칸으로만 확정 - 친구가 고른 뒤 캘린더에서 닫은 칸은 안 됨
    // (친구 응답은 지우지 않고 남겨둠 - 다시 열면 그대로 살아남)
    const openCells = await openCellsForPoll(poll);
    if (openCells) {
      for (let h = Math.floor(startMin / 60); h * 60 < endMin; h++) {
        if (!openCells.has(`${date}|${pad2(h)}`)) {
          return res.status(409).json({ message: poll.fromCalendar ? '캘린더에서 닫은 시간이 들어 있어요. 예약 가능으로 열려 있는 시간으로 골라주세요.' : '링크에 열어둔 시간으로만 확정할 수 있어요.' });
        }
      }
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
    if (!poll) return res.status(404).json({ message: '삭제됐거나 없는 약속 링크예요.' });
    if (poll.creatorId !== req.userId) return res.status(403).json({ message: '약속을 만든 사람만 취소할 수 있어요.' });
    if (poll.status === 'CANCELLED') return res.status(409).json({ message: '이미 취소된 약속이에요.' });

    let notifyIds = [];
    if (poll.status === 'CONFIRMED') {
      const memberIds = [...new Set([poll.creatorId, ...poll.responses.filter((r) => r.userId).map((r) => r.userId)])];
      const base = confirmedEventBaseTitle(poll);
      const done = await prisma.$transaction(async (tx) => {
        const changed = await tx.invitePoll.updateMany({ where: { id: poll.id, status: 'CONFIRMED' }, data: { status: 'CANCELLED' } });
        if (changed.count === 0) return false;
        // 확정할 때 addConfirmedEvent로 만든 일정(같은 사람·시간·제목)을 지우고, 원래 열어둔 시간이었으면 다시 예약 가능으로 복원
        // 제목 앞의 이름은 그 사이 프로필 이름이 바뀌었을 수 있어서 뒷부분(" 약속 - 약속이름")으로 찾고, 이름이 안 붙던 예전 일정도 같이 지움
        await tx.event.deleteMany({
          where: {
            userId: { in: memberIds }, startTime: poll.confirmedStart, endTime: poll.confirmedEnd, sourceMessageId: null,
            OR: [{ title: base }, { title: { endsWith: `과 약속 - ${base}` } }],
          },
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

// DELETE /api/invites/:token  (만든 사람만) - 목록에서 아예 지움 (친구 응답도 같이 지워지고, 링크를 열면 "없는 링크"로 나옴)
// 아직 시작 전인 확정 약속은 다른 사람 캘린더에도 들어가 있어서, 먼저 취소(모두의 캘린더에서 지우고 알림)한 뒤에 지울 수 있음.
// 이미 지난 확정 약속을 지워도 캘린더에 담긴 일정은 기록으로 남음
async function deleteInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '이미 삭제된 약속이에요.' });
    if (poll.creatorId !== req.userId) return res.status(403).json({ message: '약속을 만든 사람만 삭제할 수 있어요.' });
    if (poll.status === 'CONFIRMED' && poll.confirmedStart && poll.confirmedStart.getTime() > Date.now()) {
      return res.status(409).json({ message: '다가오는 확정 약속은 먼저 취소한 뒤에 삭제할 수 있어요.' });
    }
    await prisma.invitePoll.delete({ where: { id: poll.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[deleteInvite]', err);
    res.status(500).json({ message: '약속을 삭제하지 못했어요.' });
  }
}

// POST /api/invites/:token/claim  { guestKey }  (로그인 필요)
// 비회원으로 응답했던 사람이 가입/로그인한 뒤, 그 응답을 내 계정에 연결하고 확정된 약속을 내 캘린더에 넣음
async function claimInvite(req, res) {
  try {
    const poll = await findPollByToken(req.params.token);
    if (!poll) return res.status(404).json({ message: '삭제됐거나 없는 약속 링크예요.' });
    const guestKey = String(req.body.guestKey || '').slice(0, 64);
    const mine = findMyResponse(poll, { userId: req.userId, guestKey });
    if (!mine) return res.status(404).json({ message: '이 약속에 응답한 기록이 없어요.' });
    if (mine.userId && mine.userId !== req.userId) return res.status(403).json({ message: '다른 계정에 연결된 응답이에요.' });

    if (!mine.userId) {
      await prisma.inviteResponse.update({ where: { id: mine.id }, data: { userId: req.userId } });
    }
    // 방금 연결한 내 응답이 반영된 상태로 다시 읽어야 캘린더 제목에 내 이름이 상대 목록으로 안 들어감
    const updated = await findPollByToken(poll.token);
    let addedToCalendar = false;
    if (updated.status === 'CONFIRMED' && updated.creatorId !== req.userId) {
      await addConfirmedEvent(prisma, updated, req.userId);
      addedToCalendar = true;
    }
    res.json({ invite: serializePoll(updated, { userId: req.userId, guestKey, openCells: await openCellsForPoll(updated) }), addedToCalendar });
  } catch (err) {
    console.error('[claimInvite]', err);
    res.status(500).json({ message: '약속을 내 계정에 연결하지 못했어요.' });
  }
}

// ------------------------------------------------------------
// 카톡 등에 공유할 링크 미리보기 (GET /i/:token)
// 프론트는 정적 사이트라 링크마다 다른 미리보기를 못 만들어서, 서버가 오픈그래프 태그만 담긴 작은 페이지를
// 돌려주고 사람이 열면 바로 프론트(?invite=토큰)로 넘김. 카톡 미리보기 수집기는 자바스크립트를 안 돌려서
// 태그만 읽어감 -> "민지님의 비는 시간: 이번 주 수요일 오후 3시~6시" 같은 카드가 됨
// ------------------------------------------------------------
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 14 -> "오후 2시", 9.5 -> "오전 9시 30분" (24 = 밤 12시)
function hourLabelKo(h, { dropPeriod = false } = {}) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const period = hh === 0 || hh === 24 ? '밤' : hh < 12 ? '오전' : '오후';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${dropPeriod ? '' : `${period} `}${h12}시${mm ? ` ${mm}분` : ''}`;
}

// "오후 3시~6시" 처럼 같은 오전/오후면 뒤쪽은 생략
function hourRangeKo(start, end) {
  const samePeriod = (start < 12) === (end <= 12) && end !== 24;
  return `${hourLabelKo(start)}~${hourLabelKo(end, { dropPeriod: samePeriod })}`;
}

// 오늘 기준 "오늘" / "내일" / "이번 주 수요일" / "다음 주 수요일" / "10월 21일(화)" (한국 시간, 주는 월요일 시작)
function dateLabelKo(dateStr) {
  const day = new Date(`${dateStr}T00:00:00+09:00`);
  const today = new Date(`${todayKstStr()}T00:00:00+09:00`);
  const diff = Math.round((day - today) / 86400000);
  const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  const todayWd = new Date(`${todayKstStr()}T12:00:00Z`).getUTCDay();
  const mondayOffset = (todayWd + 6) % 7; // 오늘이 이번 주 월요일에서 며칠째인지
  const week = Math.floor((diff + mondayOffset) / 7);
  if (diff > 0 && week === 0) return `이번 주 ${WEEKDAY_KO[wd]}요일`;
  if (diff > 0 && week === 1) return `다음 주 ${WEEKDAY_KO[wd]}요일`;
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일(${WEEKDAY_KO[wd]})`;
}

// 아직 안 지난 고를 수 있는 칸들을 날짜별로 이어진 시간대로 묶음 -> [{ date, start, end }]
function upcomingRanges(poll, openCells) {
  const nowMs = Date.now();
  const cells = [...validCellSet(poll, openCells)]
    .filter((c) => { const [d, h] = c.split('|'); return kstDate(d, Number(h) + 1).getTime() > nowMs; })
    .sort();
  const ranges = [];
  cells.forEach((c) => {
    const [date, hs] = c.split('|');
    const h = Number(hs);
    const last = ranges[ranges.length - 1];
    if (last && last.date === date && last.end === h) last.end = h + 1;
    else ranges.push({ date, start: h, end: h + 1 });
  });
  return ranges;
}

function invitePreview(poll, openCells) {
  if (!poll) return { title: '캐치미 약속 링크', description: '링크를 찾을 수 없어요.' };
  const who = (poll.creator && (poll.creator.name || poll.creator.username)) || '친구';
  const where = poll.placeName ? ` @ ${poll.placeName}` : '';
  if (poll.status === 'CANCELLED') return { title: `${poll.title}`, description: '취소된 약속이에요.' };
  if (poll.status === 'CONFIRMED' && poll.confirmedStart && poll.confirmedEnd) {
    const kst = (dt) => new Date(dt.getTime() + 9 * 3600000);
    const s = kst(poll.confirmedStart);
    const e = kst(poll.confirmedEnd);
    const dateStr = s.toISOString().slice(0, 10);
    const sh = s.getUTCHours() + s.getUTCMinutes() / 60;
    const eh = e.toISOString().slice(0, 10) === dateStr ? e.getUTCHours() + e.getUTCMinutes() / 60 : 24;
    return {
      title: `약속 확정: ${dateLabelKo(dateStr)} ${hourRangeKo(sh, eh)}`,
      description: `${poll.title}${where} · ${who}님과의 약속이 정해졌어요`,
    };
  }
  if (isPollExpired(poll)) {
    return { title: `${who}님이 약속 시간을 물어봤어요`, description: `${poll.title}${where} · 날짜가 지나 마감된 링크예요` };
  }
  const ranges = upcomingRanges(poll, openCells);
  if (!ranges.length) {
    return { title: `${who}님이 약속 시간을 물어봐요`, description: `${poll.title}${where} · 지금은 고를 수 있는 시간이 없어요` };
  }
  const label = (r) => `${dateLabelKo(r.date)} ${hourRangeKo(r.start, r.end)}`;
  const more = ranges.length > 1 ? ` 외 ${ranges.length - 1}개` : '';
  return {
    title: `${who}님의 비는 시간: ${label(ranges[0])}${more}`,
    description: `${poll.title}${where} · 가입 없이 되는 시간만 눌러주세요`,
  };
}

// GET /i/:token
async function shareInvitePage(req, res) {
  const frontend = (process.env.FRONTEND_URL || 'https://catchme-29rt.onrender.com/').replace(/\/+$/, '');
  const token = String(req.params.token || '');
  const target = `${frontend}/?invite=${encodeURIComponent(token)}`;
  let preview;
  try {
    const poll = await findPollByToken(token);
    preview = invitePreview(poll, poll ? await openCellsForPoll(poll) : null);
  } catch (err) {
    console.error('[shareInvitePage]', err);
    preview = { title: '캐치미 약속 링크', description: '되는 시간만 눌러주세요' };
  }
  const self = `${req.protocol}://${req.get('host')}`;
  const t = escapeHtml(preview.title);
  const d = escapeHtml(preview.description);
  const u = escapeHtml(target);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(`<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="캐치미">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${escapeHtml(`${self}/share/catchme.png`)}">
<meta property="og:image:width" content="600">
<meta property="og:image:height" content="600">
<meta property="og:url" content="${escapeHtml(`${self}/i/${encodeURIComponent(token)}`)}">
<meta name="twitter:card" content="summary">
</head><body data-target="${u}" style="font-family:sans-serif;text-align:center;padding:40px 16px">
<p>${t}</p>
<p><a href="${u}">캐치미에서 열기</a></p>
<script src="/share/go.js"></script>
</body></html>`);
}

module.exports = {
  shareInvitePage,
  myAvailability,
  createInvite,
  listMyInvites,
  getInvite,
  respondInvite,
  confirmInvite,
  cancelInvite,
  deleteInvite,
  claimInvite,
};
