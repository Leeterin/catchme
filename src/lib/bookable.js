const prisma = require('./prisma');

const HOUR_MS = 60 * 60 * 1000;

function kstDate(dateStr, hour = 0, minute = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00+09:00`);
}

// Date -> 한국 시간 기준 "YYYY-MM-DD"
function kstDateKey(date) {
  const d = new Date(new Date(date).getTime() + 9 * HOUR_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 일정 하나가 그 날짜(dateKey)에 실제로 걸리는 구간 - 반복 일정은 요일/예외/반복 종료일을 확인하고 그 날짜 기준 시각으로 다시 계산.
// 해당 없으면 null
function occurrenceOnDate(ev, dateKey) {
  if (!ev.recurringWeekdays || ev.recurringWeekdays.length === 0) return ev;
  const dayStart = kstDate(dateKey, 0, 0);
  if (!ev.recurringWeekdays.includes(dayStart.getDay())) return null;
  if (ev.recurringExceptions && ev.recurringExceptions.includes(dateKey)) return null;
  if (ev.recurringUntil && dayStart > new Date(ev.recurringUntil)) return null;
  return {
    ...ev,
    startTime: kstDate(dateKey, ev.startTime.getHours(), ev.startTime.getMinutes()),
    endTime: kstDate(dateKey, ev.endTime.getHours(), ev.endTime.getMinutes()),
  };
}

// ownerId의 [start, end) 시간이 viewerId 입장에서 "예약 가능"인지 확인.
// 친구 캘린더(GET /events/friend/:username)와 똑같이 한 시간 칸 단위로 판단함:
// 걸치는 모든 시간 칸마다 viewer에게 공개된 "예약 가능" 일정이 겹쳐 있고, 바쁨 일정(공개 설정 무관)은 하나도 겹치지 않아야 함.
// 화면이 오래돼서 이미 다른 약속이 잡힌 시간에 요청이 들어오는 걸(더블부킹) 서버에서 막기 위함
async function isRangeBookableFor(ownerId, viewerId, start, end) {
  const rangeStart = new Date(Math.floor(start.getTime() / HOUR_MS) * HOUR_MS);
  const rangeEnd = new Date(Math.ceil(end.getTime() / HOUR_MS) * HOUR_MS);

  const [settingsRow, memberships, fetched] = await Promise.all([
    prisma.friendSettings.findUnique({ where: { ownerId_friendId: { ownerId, friendId: viewerId } } }),
    prisma.friendGroupMember.findMany({ where: { friendId: viewerId, group: { ownerId } }, select: { groupId: true } }),
    prisma.event.findMany({
      where: {
        userId: ownerId,
        OR: [
          { recurringWeekdays: { isEmpty: true }, startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
          {
            recurringWeekdays: { isEmpty: false },
            startTime: { lt: rangeEnd },
            OR: [{ recurringUntil: null }, { recurringUntil: { gte: new Date(rangeStart.getTime() - 24 * HOUR_MS) } }],
          },
        ],
      },
      select: {
        startTime: true, endTime: true, status: true, visiblePrivate: true, visibleGroupIds: true,
        recurringWeekdays: true, recurringUntil: true, recurringExceptions: true,
      },
    }),
  ]);
  const privateAccess = settingsRow ? settingsRow.privateAccess : false;
  const myGroupIds = new Set(memberships.map((m) => m.groupId));
  const visibleToViewer = (ev) => {
    if (ev.visiblePrivate) return privateAccess;
    if (ev.visibleGroupIds && ev.visibleGroupIds.length > 0) return ev.visibleGroupIds.some((gid) => myGroupIds.has(gid));
    return true;
  };

  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += HOUR_MS) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + HOUR_MS);
    const dateKey = kstDateKey(slotStart);
    const events = fetched.map((ev) => occurrenceOnDate(ev, dateKey)).filter(Boolean);
    const overlaps = (ev) => new Date(ev.startTime) < slotEnd && new Date(ev.endTime) > slotStart;
    if (events.some((ev) => ev.status === 'BUSY' && overlaps(ev))) return false;
    if (!events.some((ev) => ev.status === 'AVAILABLE' && visibleToViewer(ev) && overlaps(ev))) return false;
  }
  return true;
}

// 이 사람들 중 누군가가 [start, end)에 이미 확정된 약속(채팅에서 확정돼 캘린더에 생긴 일정)이 있는지
async function hasConfirmedAppointmentOverlap(userIds, start, end, excludeMessageId) {
  const found = await prisma.event.findFirst({
    where: {
      userId: { in: userIds },
      status: 'BUSY',
      isPendingHold: false,
      sourceMessageId: { not: null, ...(excludeMessageId ? { notIn: [excludeMessageId] } : {}) },
      startTime: { lt: end },
      endTime: { gt: start },
    },
    select: { id: true },
  });
  return !!found;
}

module.exports = { occurrenceOnDate, isRangeBookableFor, hasConfirmedAppointmentOverlap };
