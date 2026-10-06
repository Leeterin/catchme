const prisma = require('../lib/prisma');
const { isBeforeRecurrenceStart } = require('../lib/bookable');
const { fetchIcs } = require('../lib/icsFetch');
const { track } = require('../lib/analytics');

// 친구 일정 보기에서 쓰는 하루 시간 칸 (0~23시)
const MATCH_HOURS = Array.from({ length: 24 }, (_, i) => i);

// "2026-07-29" + 시(hour) 을 "한국 시간 기준" 그 시각으로 정확히 변환.
// new Date(dateStr) + setHours()는 서버가 어느 시간대로 돌아가는지에 따라 결과가 달라질 수 있어 위험하므로,
// 여기서는 타임존 오프셋(+09:00)을 문자열에 직접 명시해서 서버 설정과 무관하게 항상 정확한 시각을 만든다.
function kstDate(dateStr, hour = 0, minute = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00+09:00`);
}

// 두 사람이 실제로(수락된 상태로) 친구인지 확인 - 친구 아닌 사람과는 매칭 못 하게 막기 위함
async function areFriends(userIdA, userIdB) {
  const accepted = await prisma.friendRequest.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: userIdA, receiverId: userIdB },
        { senderId: userIdB, receiverId: userIdA },
      ],
    },
  });
  return !!accepted;
}

// GET /api/events/match?usernames=a,b&start=&end=&minHours=
// 나 + usernames로 지정한 사람들 전원이 겹치게 비어있는 시간대를, 날짜 범위 안에서 찾아준다.
// (개인 일정의 제목/내용은 절대 넘기지 않고, "그 시간에 바쁜지 아닌지"만 사용함 - 프라이버시 보호)
async function matchCalendar(req, res) {
  const { usernames, start, end } = req.query;
  const minHours = Math.max(1, parseInt(req.query.minHours, 10) || 1);

  if (!usernames || !usernames.trim()) {
    return res.status(400).json({ message: '매칭할 상대방 아이디(usernames)가 필요해요.' });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate) || isNaN(endDate) || endDate < startDate) {
    return res.status(400).json({ message: '날짜 범위가 올바르지 않아요.' });
  }

  const usernameList = usernames.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  const others = await prisma.user.findMany({ where: { username: { in: usernameList } } });
  if (others.length !== usernameList.length) {
    return res.status(404).json({ message: '일부 사용자를 찾을 수 없어요.' });
  }

  for (const other of others) {
    if (other.id === req.userId) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await areFriends(req.userId, other.id);
    if (!ok) {
      return res.status(403).json({ message: `${other.name}님과는 친구가 아니라 매칭할 수 없어요.` });
    }
  }

  const allUserIds = [req.userId, ...others.map((u) => u.id)];
  const eventsByUser = await loadMatchEventsByUser(req.userId, others.map((u) => u.id), startDate, endDate);
  const days = computeMatchDays(eventsByUser, allUserIds, startDate, endDate, minHours)
    .map((d) => ({ date: d.date, ranges: d.ranges }));
  return res.json({ days });
}

// GET /api/events/match-friends?start=&end=&minHours=
// 홈 "이번 주 시간 맞는 친구" - 친구 한 명씩 "나 + 그 친구" 둘이 겹치게 열어둔 시간을 찾아줌.
// /match와 같은 규칙(서로 '예약 가능'으로 열어둔 시간만, 바쁨 일정은 제외, 일정 내용은 안 넘김)을 그대로 씀
async function matchFriends(req, res) {
  const startDate = new Date(req.query.start);
  const endDate = new Date(req.query.end);
  const minHours = Math.max(1, parseInt(req.query.minHours, 10) || 1);
  if (isNaN(startDate) || isNaN(endDate) || endDate < startDate) {
    return res.status(400).json({ message: '날짜 범위가 올바르지 않아요.' });
  }
  if ((endDate - startDate) / 86400000 > 14) {
    return res.status(400).json({ message: '한 번에 2주까지만 볼 수 있어요.' });
  }

  const accepted = await prisma.friendRequest.findMany({
    where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    select: { senderId: true, receiverId: true },
  });
  const friendIds = [...new Set(accepted.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId)))]
    .filter((id) => id !== req.userId);
  if (friendIds.length === 0) return res.json({ friends: [], hasFriends: false });

  const friendUsers = await prisma.user.findMany({
    where: { id: { in: friendIds } },
    select: { id: true, username: true },
  });
  const eventsByUser = await loadMatchEventsByUser(req.userId, friendIds, startDate, endDate);
  // 나한테 열린 시간이 하루도 없으면 누구와도 안 겹치니 계산하지 않음
  if (!eventsByUser[req.userId].some((ev) => ev.status === 'AVAILABLE')) return res.json({ friends: [], myAvailability: false });

  const friends = [];
  friendUsers.forEach((f) => {
    if (!eventsByUser[f.id].some((ev) => ev.status === 'AVAILABLE')) return;
    const days = computeMatchDays(eventsByUser, [req.userId, f.id], startDate, endDate, minHours);
    if (days.length > 0) friends.push({ userId: f.id, username: f.username, days: days.map((d) => ({ date: d.dateKey, ranges: d.ranges })) });
  });
  // 가장 빨리 만날 수 있는 친구부터
  friends.sort((a, b) => (a.days[0].date + String(a.days[0].ranges[0].startMin).padStart(4, '0'))
    .localeCompare(b.days[0].date + String(b.days[0].ranges[0].startMin).padStart(4, '0')));
  return res.json({ friends, myAvailability: true });
}

// /match, /match-friends 공용: viewer와 otherUserIds의 일정 중 viewer에게 보이는 것만 사람별로 모아줌
// (나만보기는 privateAccess를 켜준 사람 것만, 그룹 공개는 내가 그 그룹에 있을 때만, 업무용 시간은 친구 매칭에 안 씀)
async function loadMatchEventsByUser(viewerId, otherUserIds, startDate, endDate) {
  const allUserIds = [viewerId, ...otherUserIds];
  // 다른 참여자들이 "나만보기" 일정까지 나한테 열어줬는지(privateAccess), 그리고 그 사람들의 그룹 중 내가 속한 그룹이 뭔지 미리 가져옴
  const settingsRows = await prisma.friendSettings.findMany({
    where: { friendId: viewerId, ownerId: { in: otherUserIds } },
  });
  const privateAccessMap = {};
  settingsRows.forEach((s) => { privateAccessMap[s.ownerId] = s.privateAccess; });

  const myMemberships = await prisma.friendGroupMember.findMany({
    where: { friendId: viewerId, group: { ownerId: { in: otherUserIds } } },
    select: { groupId: true, group: { select: { ownerId: true } } },
  });
  const myGroupIdsByOwner = {};
  myMemberships.forEach((m) => {
    const ownerId = m.group.ownerId;
    if (!myGroupIdsByOwner[ownerId]) myGroupIdsByOwner[ownerId] = new Set();
    myGroupIdsByOwner[ownerId].add(m.groupId);
  });

  const queryRangeEnd = new Date(endDate);
  queryRangeEnd.setDate(queryRangeEnd.getDate() + 1);

  const rawEvents = await prisma.event.findMany({
    where: {
      userId: { in: allUserIds },
      status: { in: ['BUSY', 'AVAILABLE'] },
      NOT: { status: 'BUSY', blocksBooking: false }, // "이 시간에도 예약 받기" 켠 바쁨 일정은 매칭을 막지 않음
      OR: [
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: queryRangeEnd }, endTime: { gt: startDate } },
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lt: queryRangeEnd },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: startDate } }],
        },
      ],
    },
    select: {
      userId: true, startTime: true, endTime: true, status: true, visiblePrivate: true, visibleGroupIds: true, availableFor: true,
      recurringWeekdays: true, recurringUntil: true, recurringExceptions: true,
    },
  });

  // 내 일정은 항상 나한테 보이고, 다른 사람 일정은: "나만보기"면 그 사람이 나한테 privateAccess를 켜줬을 때만,
  // 특정 그룹으로 공개돼있으면 내가 그 그룹(들) 중 하나에 속해있을 때만, 둘 다 아니면(그룹 지정 없음) 모든 친구에게 공개
  // "일만" 열어둔 시간은 친구 매칭에 안 씀 (내 것이든 친구 것이든)
  const events = rawEvents.filter((ev) => {
    if (ev.availableFor === 'work') return false;
    if (ev.userId === viewerId) return true;
    if (ev.visiblePrivate) return !!privateAccessMap[ev.userId];
    if (ev.visibleGroupIds && ev.visibleGroupIds.length > 0) {
      const myGroups = myGroupIdsByOwner[ev.userId];
      return !!myGroups && ev.visibleGroupIds.some((gid) => myGroups.has(gid));
    }
    return true;
  });

  const eventsByUser = {};
  allUserIds.forEach((id) => { eventsByUser[id] = []; });
  events.forEach((ev) => { eventsByUser[ev.userId].push(ev); });

  return eventsByUser;
}

// /match, /match-friends 공용: userIds 전원이 '예약 가능'으로 겹치게 열어둔 시간을 날짜별로 계산
// (date는 예전 응답 그대로, dateKey는 한국 날짜 YYYY-MM-DD)
function computeMatchDays(eventsByUser, allUserIds, startDate, endDate, minHours) {
  // dateObj가 나타내는 "그 날짜"를 KST 기준 YYYY-MM-DD 문자열로 바꿈 (서버 시간대 설정과 무관하게)
  function kstDateKeyFromDateObj(dateObj) {
    const shifted = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
    const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth() + 1, d = shifted.getUTCDate();
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  // 이 사람의 그 날짜 일정들을 "하루 중 몇 분" 구간으로 ([시작분, 끝분), 0~1440으로 자름)
  function dayIntervals(userId, dateKey, status) {
    const dayStart = kstDate(dateKey, 0, 0).getTime();
    const out = [];
    eventsByUser[userId].forEach((ev) => {
      if (ev.status !== status) return;
      let s;
      let e;
      if (ev.recurringWeekdays && ev.recurringWeekdays.length > 0) {
        // 반복 일정 - 이 날짜의 요일이 반복 패턴에 없거나, 예외 날짜거나, 반복 종료일을 지났으면 해당 없음
        const dow = kstDate(dateKey, 0, 0).getDay();
        if (!ev.recurringWeekdays.includes(dow)) return;
        if (ev.recurringExceptions && ev.recurringExceptions.includes(dateKey)) return;
        if (ev.recurringUntil && kstDate(dateKey, 0, 0) > new Date(ev.recurringUntil)) return;
        if (isBeforeRecurrenceStart(ev, dateKey)) return; // 반복 시작일 전
        // 시간(시:분)은 원래 저장된 그대로, 날짜만 지금 확인 중인 날로 다시 계산
        s = kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes()).getTime();
        e = kstDate(dateKey, ev.endTime.getHours(), ev.endTime.getMinutes()).getTime();
      } else {
        s = new Date(ev.startTime).getTime();
        e = new Date(ev.endTime).getTime();
      }
      const sm = Math.max(0, (s - dayStart) / 60000);
      const em = Math.min(1440, (e - dayStart) / 60000);
      if (em > sm) out.push([sm, em]);
    });
    return out;
  }

  // 5분 칸마다: 전원이 "예약 가능"으로 그 5분을 빈틈없이 덮고, 아무도 바쁨 일정과 겹치지 않으면 매칭
  // (예: 8:25까지만 예약 가능이면 매칭도 8:25에서 끝남)
  const STEP = 5;
  const SLOTS = 1440 / STEP;
  const days = [];
  const cursor = new Date(startDate);
  let safety = 0;
  while (cursor <= endDate && safety < 62) {
    const dateKey = kstDateKeyFromDateObj(cursor);
    const ok = new Array(SLOTS).fill(true);
    allUserIds.forEach((id) => {
      const avail = dayIntervals(id, dateKey, 'AVAILABLE');
      const busy = dayIntervals(id, dateKey, 'BUSY');
      for (let i = 0; i < SLOTS; i++) {
        if (!ok[i]) continue;
        const a = i * STEP;
        const z = a + STEP;
        if (!avail.some(([s, e]) => s <= a && e >= z) || busy.some(([s, e]) => s < z && e > a)) ok[i] = false;
      }
    });
    const ranges = [];
    let runStart = null;
    for (let i = 0; i <= SLOTS; i++) {
      const hit = i < SLOTS && ok[i];
      if (hit && runStart === null) runStart = i;
      if (!hit && runStart !== null) {
        const startMin = runStart * STEP;
        const endMin = i * STEP;
        if (endMin - startMin >= minHours * 60) {
          // startHour/endHour는 예전 앱 호환용 (그 안에 온전히 들어가는 정각 범위)
          ranges.push({ startMin, endMin, startHour: Math.ceil(startMin / 60), endHour: Math.floor(endMin / 60) });
        }
        runStart = null;
      }
    }
    if (ranges.length > 0) {
      days.push({ date: cursor.toISOString().slice(0, 10), dateKey, ranges });
    }
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }

  return days;
}

function serializeEvent(event) {
  return {
    id: event.id,
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    status: event.status,
    eventType: event.eventType,
    availableFor: event.availableFor || 'all',
    blocksBooking: event.blocksBooking !== false,
    isPendingHold: event.isPendingHold,
    // 확정된 예약(약속)이라 채팅에서만 취소할 수 있는 일정인지 - 홀드가 아니면서 채팅방에 연결돼 있으면 그런 경우임
    isReservationLinked: !event.isPendingHold && !!event.sourceChatRoomId,
    sourceChatRoomId: event.sourceChatRoomId,
    recurringWeekdays: event.recurringWeekdays,
    recurringUntil: event.recurringUntil,
    recurringExceptions: event.recurringExceptions,
    color: event.color || null,
    visibility: {
      groupIds: event.visibleGroupIds || [],
      private: event.visiblePrivate,
    },
    createdAt: event.createdAt,
  };
}

function parseRange(query) {
  // ?start=&end= 로 명시적인 범위를 주거나, ?year=&month=(1~12) 로 그 달 전체를 요청할 수 있음
  if (query.start && query.end) {
    return { start: new Date(query.start), end: new Date(query.end) };
  }
  const now = new Date();
  const year = parseInt(query.year, 10) || now.getFullYear();
  const month = query.month ? parseInt(query.month, 10) - 1 : now.getMonth();
  return {
    start: new Date(year, month, 1),
    end: new Date(year, month + 1, 1),
  };
}

// GET /api/events?start=&end=  또는  ?year=&month=
async function listEvents(req, res) {
  const { start, end } = parseRange(req.query);
  if (isNaN(start) || isNaN(end)) {
    return res.status(400).json({ message: '날짜 범위가 올바르지 않아요.' });
  }

  const events = await prisma.event.findMany({
    where: {
      userId: req.userId,
      OR: [
        // 일반(비반복) 일정 - 시작~종료가 요청 범위와 겹치면 포함
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: end }, endTime: { gt: start } },
        // 반복 일정 - "첫 발생일"이 요청 범위보다 뒤가 아니고, 반복 종료일(있다면)이 요청 범위보다 앞이 아니면
        // 이 범위 안 어딘가에 실제로 발생할 수 있으므로 포함시킴 (구체적으로 어느 요일에 뜨는지는 프론트에서 계산)
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lt: end },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: start } }],
        },
      ],
    },
    orderBy: { startTime: 'asc' },
  });

  return res.json({ events: events.map(serializeEvent) });
}

// GET /api/events/:id
async function getEvent(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.userId !== req.userId) {
    return res.status(404).json({ message: '일정을 찾을 수 없어요.' });
  }
  return res.json({ event: serializeEvent(event) });
}

function validateEventInput({ title, startTime, endTime, status }, { partial } = {}) {
  const errors = {};

  if (!partial || title !== undefined) {
    if (!title || !title.trim()) errors.title = '일정 제목을 입력해주세요.';
  }

  const start = startTime !== undefined ? new Date(startTime) : undefined;
  const end = endTime !== undefined ? new Date(endTime) : undefined;

  if (!partial || startTime !== undefined) {
    if (!startTime || isNaN(start)) errors.startTime = '시작 시간이 올바르지 않아요.';
  }
  if (!partial || endTime !== undefined) {
    if (!endTime || isNaN(end)) errors.endTime = '종료 시간이 올바르지 않아요.';
  }
  if (start && end && end <= start) {
    errors.endTime = '종료 시간은 시작 시간보다 뒤여야 해요.';
  }
  if (status !== undefined && !['BUSY', 'AVAILABLE'].includes(status)) {
    errors.status = "status는 'BUSY' 또는 'AVAILABLE'이어야 해요.";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// visibility.groupIds로 넘어온 값 중, 실제로 이 사람이 소유한 그룹 id만 걸러서 돌려줌 (엉뚱한/남의 그룹 id가 섞여도 안전하게)
async function sanitizeGroupIds(ownerId, groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) return [];
  const owned = await prisma.friendGroup.findMany({
    where: { ownerId, id: { in: groupIds } },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((g) => g.id));
  return [...new Set(groupIds)].filter((id) => ownedSet.has(id));
}

// 일정 색상 입력 정리 - "#RRGGBB" 형식만 받고, 빈 값/null은 "색 지정 안 함"(테마 기본 색)으로 취급.
// 그 외 이상한 값이면 undefined를 돌려줘서 기존 값을 건드리지 않음
function sanitizeEventColor(color) {
  if (color === null || color === '') return null;
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase();
  return undefined;
}

// 예약 가능을 누구에게 열지 - 이상한 값이면 undefined (생성 땐 'all'로, 수정 땐 기존 값 유지)
const AVAILABLE_FOR = ['all', 'friends', 'work'];
function sanitizeAvailableFor(v) {
  return AVAILABLE_FOR.includes(v) ? v : undefined;
}

// POST /api/events   body: { title, startTime, endTime, status?, eventType?, visibility?:{groupIds,private}, recurringWeekdays?, recurringUntil?, color? }
async function createEvent(req, res) {
  const { title, startTime, endTime, status, eventType, visibility, sourceChatRoomId, recurringWeekdays, recurringUntil, color, availableFor, blocksBooking } = req.body;
  const { valid, errors } = validateEventInput({ title, startTime, endTime, status });
  if (!valid) return res.status(400).json({ message: '입력값을 확인해주세요.', errors });

  const weekdays = Array.isArray(recurringWeekdays)
    ? recurringWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];

  const isPrivate = visibility && typeof visibility.private === 'boolean' ? visibility.private : false;
  const groupIds = isPrivate ? [] : await sanitizeGroupIds(req.userId, visibility && visibility.groupIds);

  const event = await prisma.event.create({
    data: {
      userId: req.userId,
      title: title.trim(),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      status: status || 'BUSY',
      eventType: eventType === 'available' ? 'available' : 'busy',
      availableFor: sanitizeAvailableFor(availableFor) || 'all',
      blocksBooking: blocksBooking !== false,
      visiblePrivate: isPrivate,
      visibleGroupIds: groupIds,
      sourceChatRoomId: typeof sourceChatRoomId === 'string' ? sourceChatRoomId : null,
      recurringWeekdays: weekdays,
      recurringUntil: weekdays.length > 0 && recurringUntil ? new Date(recurringUntil) : null,
      color: sanitizeEventColor(color) || null,
    },
  });
  if (!sourceChatRoomId) track(req.userId, eventType === 'available' ? 'available_created' : 'event_created');

  return res.status(201).json({ event: serializeEvent(event) });
}

// PATCH /api/events/:id   body: { title?, startTime?, endTime?, status?, recurringWeekdays?, recurringUntil?, recurringExceptions?, color? }
async function updateEvent(req, res) {
  const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ message: '일정을 찾을 수 없어요.' });
  }

  const { title, startTime, endTime, status, eventType, visibility, recurringWeekdays, recurringUntil, recurringExceptions, color, availableFor, blocksBooking } = req.body;
  const { valid, errors } = validateEventInput({ title, startTime, endTime, status }, { partial: true });
  if (!valid) return res.status(400).json({ message: '입력값을 확인해주세요.', errors });

  const nextStart = startTime !== undefined ? new Date(startTime) : existing.startTime;
  const nextEnd = endTime !== undefined ? new Date(endTime) : existing.endTime;
  if (nextEnd <= nextStart) {
    return res.status(400).json({ message: '입력값을 확인해주세요.', errors: { endTime: '종료 시간은 시작 시간보다 뒤여야 해요.' } });
  }

  const weekdays = Array.isArray(recurringWeekdays)
    ? recurringWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : undefined;

  // visibility는 { private, groupIds } 통째로 하나의 단위로 취급함 - 넘어오면 두 필드를 한 번에 새로 정함,
  // 아예 안 넘어오면(undefined) 기존 공개 설정을 그대로 둠 (PATCH 부분 업데이트 규칙)
  let visiblePrivateUpdate;
  let visibleGroupIdsUpdate;
  if (visibility !== undefined && visibility !== null) {
    const isPrivate = typeof visibility.private === 'boolean' ? visibility.private : false;
    visiblePrivateUpdate = isPrivate;
    // eslint-disable-next-line no-await-in-loop
    visibleGroupIdsUpdate = isPrivate ? [] : await sanitizeGroupIds(req.userId, visibility.groupIds);
  }

  const updated = await prisma.event.update({
    where: { id: req.params.id },
    data: {
      title: title !== undefined ? title.trim() : undefined,
      startTime: startTime !== undefined ? nextStart : undefined,
      endTime: endTime !== undefined ? nextEnd : undefined,
      status: status !== undefined ? status : undefined,
      eventType: eventType !== undefined ? (eventType === 'available' ? 'available' : 'busy') : undefined,
      availableFor: sanitizeAvailableFor(availableFor),
      blocksBooking: typeof blocksBooking === 'boolean' ? blocksBooking : undefined,
      visiblePrivate: visiblePrivateUpdate,
      visibleGroupIds: visibleGroupIdsUpdate,
      recurringWeekdays: weekdays,
      recurringUntil: recurringUntil !== undefined ? (recurringUntil ? new Date(recurringUntil) : null) : undefined,
      recurringExceptions: Array.isArray(recurringExceptions) ? recurringExceptions : undefined,
      color: sanitizeEventColor(color),
    },
  });

  return res.json({ event: serializeEvent(updated) });
}

// DELETE /api/events/:id
async function deleteEvent(req, res) {
  const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ message: '일정을 찾을 수 없어요.' });
  }

  await prisma.event.delete({ where: { id: req.params.id } });
  return res.json({ message: '일정을 삭제했어요.' });
}

// GET /api/events/friend/:username?date=YYYY-MM-DD
// 친구 한 명의 특정 날짜 시간대별 바쁨/가능 여부만 돌려줌 (일정 제목/내용은 절대 포함하지 않음 - 프라이버시)
async function getFriendDaySchedule(req, res) {
  const { username } = req.params;
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ message: '날짜(date)가 필요해요.' });
  }
  const dayStart = kstDate(date, 0, 0);
  if (isNaN(dayStart)) {
    return res.status(400).json({ message: '날짜 형식이 올바르지 않아요.' });
  }
  const dayEnd = kstDate(date, 24, 0);

  const friend = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
  if (!friend) {
    return res.status(404).json({ message: '사용자를 찾을 수 없어요.' });
  }
  if (friend.id !== req.userId) {
    const ok = await areFriends(req.userId, friend.id);
    if (!ok) {
      return res.status(403).json({ message: '친구가 아니라 캘린더를 볼 수 없어요.' });
    }
  }

  // "나만보기" 일정까지 나한테 열어줬는지(privateAccess), 그리고 이 친구의 그룹 중 내가 속한 그룹이 뭔지 확인
  const settingsRow = friend.id === req.userId
    ? null
    : await prisma.friendSettings.findUnique({ where: { ownerId_friendId: { ownerId: friend.id, friendId: req.userId } } });
  const myPrivateAccess = settingsRow ? settingsRow.privateAccess : false;
  const myGroupIds = friend.id === req.userId
    ? new Set()
    : new Set((await prisma.friendGroupMember.findMany({ where: { friendId: req.userId, group: { ownerId: friend.id } }, select: { groupId: true } })).map((m) => m.groupId));

  const rawEventsFetched = await prisma.event.findMany({
    where: {
      userId: friend.id,
      NOT: { status: 'BUSY', blocksBooking: false }, // "이 시간에도 예약 받기" 켠 바쁨 일정은 친구에겐 없는 것처럼
      OR: [
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: dayEnd }, endTime: { gt: dayStart } },
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lte: dayEnd },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: dayStart } }],
        },
      ],
    },
    select: {
      startTime: true, endTime: true, status: true, title: true, visiblePrivate: true, visibleGroupIds: true, availableFor: true,
      recurringWeekdays: true, recurringUntil: true, recurringExceptions: true,
    },
  });

  // 반복 일정은 이 특정 날짜의 요일에 실제로 해당하는지 확인하고, 시간(시:분)은 그대로 두되 날짜만 이 날로 다시 계산함
  const dow = dayStart.getDay();
  const rawEvents = rawEventsFetched
    .map((ev) => {
      if (ev.recurringWeekdays.length === 0) return ev;
      if (!ev.recurringWeekdays.includes(dow)) return null;
      if (ev.recurringExceptions.includes(date)) return null;
      return {
        ...ev,
        startTime: kstDate(date, ev.startTime.getHours(), ev.startTime.getMinutes()),
        endTime: kstDate(date, ev.endTime.getHours(), ev.endTime.getMinutes()),
      };
    })
    .filter(Boolean);

  // 본인이 자기 캘린더를 보는 경우가 아니면, 그 일정의 공개 설정을 따름.
  // 이 공개설정을 통과한 일정이면(=바쁨 여부를 볼 수 있는 일정이면) 제목도 함께 보여줌 - 별도의 "전체 공개" 설정은 더 이상 필요 없음.
  // "나만보기" 일정은 원래 아무한테도 안 보이지만, 그 친구가 나한테 privateAccess를 켜줬으면 예외로 보여줌.
  // 특정 그룹에게만 공개된 일정은 내가 그 그룹(들) 중 하나에 속해있을 때만 보임
  // "일만" 열어둔 시간은 친구에게 안 보임 (예약할 수 없는 빈 시간처럼 보임)
  const events = friend.id === req.userId
    ? rawEvents.filter((ev) => ev.availableFor !== 'work')
    : rawEvents.filter((ev) => {
        if (ev.availableFor === 'work') return false;
        if (ev.visiblePrivate) return myPrivateAccess;
        if (ev.visibleGroupIds && ev.visibleGroupIds.length > 0) return ev.visibleGroupIds.some((gid) => myGroupIds.has(gid));
        return true;
      });

  // 바쁜지 여부(busy) 자체는 이 앱의 원칙대로 공개설정과 무관하게 항상 보여줌 - "나만보기"로 해놔도 그 시간이
  // 통째로 비어있는 것처럼 보이면 안 되니까(그럼 상대가 그 시간을 예약해버릴 수 있음). 내용(제목)만 공개설정을 따름.
  const busy = MATCH_HOURS.map((hour) => {
    const slotStart = kstDate(date, hour, 0);
    const slotEnd = kstDate(date, hour + 1, 0);
    return rawEvents.some((ev) => ev.status === 'BUSY' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
  });
  const bookable = MATCH_HOURS.map((hour) => {
    const slotStart = kstDate(date, hour, 0);
    const slotEnd = kstDate(date, hour + 1, 0);
    const hasAvailable = events.some((ev) => ev.status === 'AVAILABLE' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
    if (!hasAvailable) return false;
    // 혹시 같은 시간에 바쁨(약속 등) 일정도 겹쳐 남아있으면, 예약 가능한 걸로 절대 보여주지 않음 (데이터 정합성 안전장치, 공개설정과 무관하게 확인)
    const alsoBusy = rawEvents.some((ev) => ev.status === 'BUSY' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
    return !alsoBusy;
  });

  // 제목은 공개설정(친구/비즈니스)을 통과한 일정에서만 가져옴 - "나만보기"거나 분류가 안 맞으면 null이라 프론트에서 "일정"으로만 표시됨
  const titles = MATCH_HOURS.map((hour) => {
    const slotStart = kstDate(date, hour, 0);
    const slotEnd = kstDate(date, hour + 1, 0);
    const match = events.find((ev) => ev.status === 'BUSY' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
    return match ? match.title : null;
  });

  return res.json({ hours: MATCH_HOURS, busy, bookable, titles });
}

// GET /api/events/friend/:username/month?year=Y&month=M(1~12)
// 한달 캘린더 보기용 - 그 달 하루하루의 바쁨/가능/제목을 한 번에 계산해서 돌려줌 (하루씩 따로 요청 안 해도 되게)
async function getFriendMonthSchedule(req, res) {
  const { username } = req.params;
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10); // 1~12로 받음
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ message: '연도(year)와 월(month, 1~12)이 필요해요.' });
  }

  const friend = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
  if (!friend) {
    return res.status(404).json({ message: '사용자를 찾을 수 없어요.' });
  }
  if (friend.id !== req.userId) {
    const ok = await areFriends(req.userId, friend.id);
    if (!ok) {
      return res.status(403).json({ message: '친구가 아니라 캘린더를 볼 수 없어요.' });
    }
  }

  const settingsRow = friend.id === req.userId
    ? null
    : await prisma.friendSettings.findUnique({ where: { ownerId_friendId: { ownerId: friend.id, friendId: req.userId } } });
  const myPrivateAccess = settingsRow ? settingsRow.privateAccess : false;
  const myGroupIds = friend.id === req.userId
    ? new Set()
    : new Set((await prisma.friendGroupMember.findMany({ where: { friendId: req.userId, group: { ownerId: friend.id } }, select: { groupId: true } })).map((m) => m.groupId));

  const pad = (n) => String(n).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStartKey = `${year}-${pad(month)}-01`;
  const monthEndKey = `${year}-${pad(month)}-${pad(daysInMonth)}`;
  const rangeStart = kstDate(monthStartKey, 0, 0);
  const rangeEnd = kstDate(monthEndKey, 24, 0);

  const rawEventsFetched = await prisma.event.findMany({
    where: {
      userId: friend.id,
      NOT: { status: 'BUSY', blocksBooking: false }, // "이 시간에도 예약 받기" 켠 바쁨 일정은 친구에겐 없는 것처럼
      OR: [
        { recurringWeekdays: { isEmpty: true }, startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
        {
          recurringWeekdays: { isEmpty: false },
          startTime: { lte: rangeEnd },
          OR: [{ recurringUntil: null }, { recurringUntil: { gte: rangeStart } }],
        },
      ],
    },
    select: {
      startTime: true, endTime: true, status: true, title: true, visiblePrivate: true, visibleGroupIds: true, availableFor: true,
      recurringWeekdays: true, recurringUntil: true, recurringExceptions: true,
    },
  });

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${pad(month)}-${pad(d)}`;
    const dow = new Date(year, month - 1, d).getDay();

    // 이 날짜에 실제로 적용되는 일정만 추려냄 (반복 일정은 요일/예외 확인 후 이 날짜 기준 시간으로 재계산)
    const rawEvents = rawEventsFetched
      .map((ev) => {
        if (ev.recurringWeekdays.length === 0) return ev;
        if (!ev.recurringWeekdays.includes(dow)) return null;
        if (ev.recurringExceptions.includes(dateKey)) return null;
        if (ev.recurringUntil && kstDate(dateKey, 0, 0) > new Date(ev.recurringUntil)) return null; // 반복이 끝난 날은 빼기
        if (isBeforeRecurrenceStart(ev, dateKey)) return null; // 반복 시작일 전
        return {
          ...ev,
          startTime: kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes()),
          endTime: kstDate(dateKey, ev.endTime.getHours(), ev.endTime.getMinutes()),
        };
      })
      .filter(Boolean);
    const events = friend.id === req.userId
      ? rawEvents.filter((ev) => ev.availableFor !== 'work')
      : rawEvents.filter((ev) => {
          if (ev.availableFor === 'work') return false;
          if (ev.visiblePrivate) return myPrivateAccess;
          if (ev.visibleGroupIds && ev.visibleGroupIds.length > 0) return ev.visibleGroupIds.some((gid) => myGroupIds.has(gid));
          return true;
        });

    // 바쁜지 여부는 공개설정과 무관하게 항상 보여줌(내용/제목만 공개설정을 따름) - "나만보기" 일정도 그 시간이 비어있는 것처럼 보이면 안 됨
    const busy = MATCH_HOURS.map((hour) => {
      const slotStart = kstDate(dateKey, hour, 0);
      const slotEnd = kstDate(dateKey, hour + 1, 0);
      return rawEvents.some((ev) => ev.status === 'BUSY' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
    });
    const bookable = MATCH_HOURS.map((hour, idx) => {
      if (busy[idx]) return false; // 같은 시간에 바쁨 일정도 겹쳐 남아있으면 예약 가능으로 안 보여줌 (데이터 정합성 안전장치)
      const slotStart = kstDate(dateKey, hour, 0);
      const slotEnd = kstDate(dateKey, hour + 1, 0);
      return events.some((ev) => ev.status === 'AVAILABLE' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
    });
    const titles = MATCH_HOURS.map((hour) => {
      const slotStart = kstDate(dateKey, hour, 0);
      const slotEnd = kstDate(dateKey, hour + 1, 0);
      const match = events.find((ev) => ev.status === 'BUSY' && new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart);
      return match ? match.title : null;
    });
    days.push({ date: dateKey, busy, bookable, titles });
  }

  return res.json({ hours: MATCH_HOURS, days });
}

// POST /api/events/import   body: { source: 'device'|'ics', events: [{ title, startTime, endTime }] }
// 휴대폰 캘린더/캘린더 주소에서 가져온 일정을 한 번에 저장. 전부 "바쁨" + "나만 보기"로 저장해서 친구에게는 제목 없이
// '일정 있음'으로만 보임 (내 전체 일정은 공개하지 않는다는 원칙 - 다른 캘린더의 일정 제목이 그대로 친구에게 노출되면 안 됨).
// 같은 걸 두 번 불러와도 안 겹치게, 이미 있는 내 일정과 제목·시작·종료가 똑같으면 건너뜀
const IMPORT_MAX = 1000;
async function importEvents(req, res) {
  const list = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, IMPORT_MAX) : [];
  const rows = [];
  for (const e of list) {
    if (!e || typeof e.title !== 'string') continue;
    const title = e.title.trim().slice(0, 60) || '일정';
    const start = new Date(e.startTime);
    const end = new Date(e.endTime);
    if (isNaN(start) || isNaN(end) || end <= start) continue;
    if (end - start > 31 * 86400e3) continue; // 한 달 넘게 이어지는 일정은 사실상 표시용이라 빼둠
    rows.push({ title, start, end });
  }
  if (rows.length === 0) return res.json({ created: 0, skipped: list.length });

  const minStart = new Date(Math.min(...rows.map((r) => r.start.getTime())));
  const maxEnd = new Date(Math.max(...rows.map((r) => r.end.getTime())));
  const existing = await prisma.event.findMany({
    where: { userId: req.userId, startTime: { gte: minStart }, endTime: { lte: maxEnd } },
    select: { title: true, startTime: true, endTime: true },
  });
  const keyOf = (title, s, e) => `${title}|${s.getTime()}|${e.getTime()}`;
  const seen = new Set(existing.map((x) => keyOf(x.title, x.startTime, x.endTime)));
  const data = [];
  for (const r of rows) {
    const k = keyOf(r.title, r.start, r.end);
    if (seen.has(k)) continue;
    seen.add(k);
    data.push({ userId: req.userId, title: r.title, startTime: r.start, endTime: r.end, status: 'BUSY', eventType: 'busy', visiblePrivate: true });
  }
  if (data.length) await prisma.event.createMany({ data });
  track(req.userId, 'calendar_import', { source: req.body.source === 'device' ? 'device' : 'ics', created: data.length });
  return res.status(201).json({ created: data.length, skipped: list.length - data.length });
}

// GET /api/events/ics?url=... - 캘린더 주소(ICS)를 대신 받아서 원문 그대로 돌려줌 (파싱은 프론트)
async function fetchIcsProxy(req, res) {
  try {
    const text = await fetchIcs(req.query.url);
    res.type('text/calendar').send(text);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('[ics] fetch failed:', err.message);
    return res.status(400).json({ message: '캘린더를 불러오지 못했어요. 주소를 다시 확인해 주세요.' });
  }
}

module.exports = { listEvents, getEvent, createEvent, updateEvent, deleteEvent, matchCalendar, matchFriends, getFriendDaySchedule, getFriendMonthSchedule, importEvents, fetchIcsProxy };
