const prisma = require('../lib/prisma');

// 매칭 계산에서 볼 하루 시간 범위 (프론트엔드 HOURS 배열과 정확히 동일하게 9시~23시, 15칸)
const MATCH_HOURS = Array.from({ length: 15 }, (_, i) => i + 9);

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
  const otherUserIds = others.map((u) => u.id);

  // 다른 참여자들이 "나만보기" 일정까지 나한테 열어줬는지(privateAccess), 그리고 그 사람들의 그룹 중 내가 속한 그룹이 뭔지 미리 가져옴
  const settingsRows = await prisma.friendSettings.findMany({
    where: { friendId: req.userId, ownerId: { in: otherUserIds } },
  });
  const privateAccessMap = {};
  settingsRows.forEach((s) => { privateAccessMap[s.ownerId] = s.privateAccess; });

  const myMemberships = await prisma.friendGroupMember.findMany({
    where: { friendId: req.userId, group: { ownerId: { in: otherUserIds } } },
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
      userId: true, startTime: true, endTime: true, status: true, visiblePrivate: true, visibleGroupIds: true,
      recurringWeekdays: true, recurringUntil: true, recurringExceptions: true,
    },
  });

  // 내 일정은 항상 나한테 보이고, 다른 사람 일정은: "나만보기"면 그 사람이 나한테 privateAccess를 켜줬을 때만,
  // 특정 그룹으로 공개돼있으면 내가 그 그룹(들) 중 하나에 속해있을 때만, 둘 다 아니면(그룹 지정 없음) 모든 친구에게 공개
  const events = rawEvents.filter((ev) => {
    if (ev.userId === req.userId) return true;
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

  // dateObj가 나타내는 "그 날짜"를 KST 기준 YYYY-MM-DD 문자열로 바꿈 (서버 시간대 설정과 무관하게)
  function kstDateKeyFromDateObj(dateObj) {
    const shifted = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
    const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth() + 1, d = shifted.getUTCDate();
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  function isBusyAt(userId, dateObj, hour) {
    const dateKey = kstDateKeyFromDateObj(dateObj);
    const slotStart = kstDate(dateKey, hour, 0);
    const slotEnd = kstDate(dateKey, hour + 1, 0);
    return eventsByUser[userId].some((ev) => {
      if (ev.status !== 'BUSY') return false;
      if (ev.recurringWeekdays && ev.recurringWeekdays.length > 0) {
        // 반복 일정 - 이 날짜의 요일이 반복 패턴에 없거나, 예외 날짜거나, 반복 종료일을 지났으면 해당 없음
        const dow = kstDate(dateKey, 0, 0).getDay();
        if (!ev.recurringWeekdays.includes(dow)) return false;
        if (ev.recurringExceptions && ev.recurringExceptions.includes(dateKey)) return false;
        if (ev.recurringUntil && kstDate(dateKey, 0, 0) > new Date(ev.recurringUntil)) return false;
        // 시간(시:분)은 원래 저장된 그대로, 날짜만 지금 확인 중인 날로 다시 계산해서 비교
        // 종료 시각은 그날 날짜 + 원래 끝나던 시:분이 아니라, 시작 시각 + 원래 지속 시간으로 구함 -
        // 자정 넘기는 반복 일정(예: 23:00~01:00)은 끝나는 시:분이 시작보다 빨라서, 그대로 쓰면 종료가
        // 시작보다 앞선 뒤집힌 구간이 돼버림.
        const occStart = kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes());
        const occEnd = new Date(occStart.getTime() + (new Date(ev.endTime).getTime() - new Date(ev.startTime).getTime()));
        return occStart < slotEnd && occEnd > slotStart;
      }
      return new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart;
    });
  }

  // 이 시간이 "예약 가능"으로 명시적으로 표시돼있는지 확인 (매칭은 이제 그냥 비어있는 시간이 아니라,
  // 서로 예약 가능으로 표시해둔 시간의 교집합만 인정함)
  function isAvailableAt(userId, dateObj, hour) {
    const dateKey = kstDateKeyFromDateObj(dateObj);
    const slotStart = kstDate(dateKey, hour, 0);
    const slotEnd = kstDate(dateKey, hour + 1, 0);
    return eventsByUser[userId].some((ev) => {
      if (ev.status !== 'AVAILABLE') return false;
      if (ev.recurringWeekdays && ev.recurringWeekdays.length > 0) {
        const dow = kstDate(dateKey, 0, 0).getDay();
        if (!ev.recurringWeekdays.includes(dow)) return false;
        if (ev.recurringExceptions && ev.recurringExceptions.includes(dateKey)) return false;
        if (ev.recurringUntil && kstDate(dateKey, 0, 0) > new Date(ev.recurringUntil)) return false;
        // 종료 시각은 그날 날짜 + 원래 끝나던 시:분이 아니라, 시작 시각 + 원래 지속 시간으로 구함 -
        // 자정 넘기는 반복 일정(예: 23:00~01:00)은 끝나는 시:분이 시작보다 빨라서, 그대로 쓰면 종료가
        // 시작보다 앞선 뒤집힌 구간이 돼버림.
        const occStart = kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes());
        const occEnd = new Date(occStart.getTime() + (new Date(ev.endTime).getTime() - new Date(ev.startTime).getTime()));
        return occStart < slotEnd && occEnd > slotStart;
      }
      return new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart;
    });
  }

  const days = [];
  const cursor = new Date(startDate);
  let safety = 0;
  while (cursor <= endDate && safety < 62) {
    const ranges = [];
    let rangeStartHour = null;
    for (let i = 0; i <= MATCH_HOURS.length; i++) {
      const hour = MATCH_HOURS[i];
      const allMatch = i < MATCH_HOURS.length && allUserIds.every((id) => isAvailableAt(id, cursor, hour) && !isBusyAt(id, cursor, hour));
      if (allMatch && rangeStartHour === null) {
        rangeStartHour = hour;
      } else if (!allMatch && rangeStartHour !== null) {
        const endHour = MATCH_HOURS[i - 1] + 1;
        if (endHour - rangeStartHour >= minHours) {
          ranges.push({ startHour: rangeStartHour, endHour });
        }
        rangeStartHour = null;
      }
    }
    if (ranges.length > 0) {
      days.push({ date: cursor.toISOString().slice(0, 10), ranges });
    }
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }

  return res.json({ days });
}

function serializeEvent(event) {
  return {
    id: event.id,
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    status: event.status,
    eventType: event.eventType,
    isPendingHold: event.isPendingHold,
    // 확정된 예약(약속)이라 채팅에서만 취소할 수 있는 일정인지 - 홀드가 아니면서 채팅방에 연결돼 있으면 그런 경우임
    isReservationLinked: !event.isPendingHold && !!event.sourceChatRoomId,
    sourceChatRoomId: event.sourceChatRoomId,
    recurringWeekdays: event.recurringWeekdays,
    recurringUntil: event.recurringUntil,
    recurringExceptions: event.recurringExceptions,
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

// POST /api/events   body: { title, startTime, endTime, status?, eventType?, visibility?:{groupIds,private}, recurringWeekdays?, recurringUntil? }
async function createEvent(req, res) {
  const { title, startTime, endTime, status, eventType, visibility, sourceChatRoomId, recurringWeekdays, recurringUntil } = req.body;
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
      visiblePrivate: isPrivate,
      visibleGroupIds: groupIds,
      sourceChatRoomId: typeof sourceChatRoomId === 'string' ? sourceChatRoomId : null,
      recurringWeekdays: weekdays,
      recurringUntil: weekdays.length > 0 && recurringUntil ? new Date(recurringUntil) : null,
    },
  });

  return res.status(201).json({ event: serializeEvent(event) });
}

// PATCH /api/events/:id   body: { title?, startTime?, endTime?, status?, recurringWeekdays?, recurringUntil?, recurringExceptions? }
async function updateEvent(req, res) {
  const existing = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ message: '일정을 찾을 수 없어요.' });
  }

  const { title, startTime, endTime, status, eventType, visibility, recurringWeekdays, recurringUntil, recurringExceptions } = req.body;
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
      visiblePrivate: visiblePrivateUpdate,
      visibleGroupIds: visibleGroupIdsUpdate,
      recurringWeekdays: weekdays,
      recurringUntil: recurringUntil !== undefined ? (recurringUntil ? new Date(recurringUntil) : null) : undefined,
      recurringExceptions: Array.isArray(recurringExceptions) ? recurringExceptions : undefined,
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
      startTime: true, endTime: true, status: true, title: true, visiblePrivate: true, visibleGroupIds: true,
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
      // 종료 시각은 "이 날짜 + 원래 끝나던 시:분"이 아니라 "새로 계산한 시작 시각 + 원래 지속 시간"으로 구함 -
      // 자정을 넘기는 반복 일정(예: 23:00~01:00)은 끝나는 시:분이 시작보다 빠르기 때문에, 그날 날짜를 그대로
      // 끝 시각에도 써버리면 종료가 시작보다 앞서는(음수 지속시간) 뒤집힌 구간이 돼서 매칭 계산이 깨짐.
      const occStart = kstDate(date, ev.startTime.getHours(), ev.startTime.getMinutes());
      const occEnd = new Date(occStart.getTime() + (new Date(ev.endTime).getTime() - new Date(ev.startTime).getTime()));
      return {
        ...ev,
        startTime: occStart,
        endTime: occEnd,
      };
    })
    .filter(Boolean);

  // 본인이 자기 캘린더를 보는 경우가 아니면, 그 일정의 공개 설정을 따름.
  // 이 공개설정을 통과한 일정이면(=바쁨 여부를 볼 수 있는 일정이면) 제목도 함께 보여줌 - 별도의 "전체 공개" 설정은 더 이상 필요 없음.
  // "나만보기" 일정은 원래 아무한테도 안 보이지만, 그 친구가 나한테 privateAccess를 켜줬으면 예외로 보여줌.
  // 특정 그룹에게만 공개된 일정은 내가 그 그룹(들) 중 하나에 속해있을 때만 보임
  const events = friend.id === req.userId
    ? rawEvents
    : rawEvents.filter((ev) => {
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
      startTime: true, endTime: true, status: true, title: true, visiblePrivate: true, visibleGroupIds: true,
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
        // (자정 넘기는 반복 일정 보정 - 위 getFriendDaySchedule과 같은 이유)
        const occStart = kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes());
        return {
          ...ev,
          startTime: occStart,
          endTime: new Date(occStart.getTime() + (new Date(ev.endTime).getTime() - new Date(ev.startTime).getTime())),
        };
      })
      .filter(Boolean);
    const events = friend.id === req.userId
      ? rawEvents
      : rawEvents.filter((ev) => {
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

module.exports = { listEvents, getEvent, createEvent, updateEvent, deleteEvent, matchCalendar, getFriendDaySchedule, getFriendMonthSchedule };
