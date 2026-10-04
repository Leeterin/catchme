// 정기 알림 - 앱을 다시 열 이유를 주는 두 가지.
//  1) 아침 8시: 오늘 일정이 있는 사람에게 "오늘 일정 N개 · 10:00 수업" (일정 없는 날엔 안 보냄)
//  2) 일요일 저녁 7시: 다음 주에 열어둔 예약 가능 시간이 없는 사람에게 "다음 주 시간 열어둘까요?"
// 서버 안에서 5분마다 확인하고(runEngagementTick), Render가 잠들어 있으면 못 도니까 바깥 크론이 /api/cron/tick을 불러도 됨.
// 같은 날 두 번 보내지 않게 user_engagement 테이블에 마지막으로 보낸 날을 남기고, 그걸 먼저 "선점"한 쪽만 보냄.
const prisma = require('./prisma');
const { sendPushToUsers } = require('./push');
const { track, kstDayKey } = require('./analytics');

const MORNING_HOUR = 8;
const MORNING_UNTIL = 11; // 서버가 늦게 깨어났어도 점심 넘어서 "오늘 일정" 알림이 가진 않게
const WEEKLY_DOW = 0; // 일요일
const WEEKLY_HOUR = 19;
const WEEKLY_UNTIL = 22;

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 반복 일정까지 포함해서, 그날(00:00~24:00)에 걸치는 일정인지 + 그날 기준 시작 시각
function occurrenceOn(ev, dayStart) {
  const dayEnd = new Date(dayStart.getTime() + 86400e3);
  const weekdays = ev.recurringWeekdays || [];
  if (weekdays.length === 0) {
    if (ev.startTime < dayEnd && ev.endTime > dayStart) return { start: ev.startTime > dayStart ? ev.startTime : null };
    return null;
  }
  // 반복(또는 요일 7개 = 여러 날짜 기간지정): 시작일 이후, 종료일 이전, 그 요일, 예외 날짜 아님
  const anchor = new Date(ev.startTime); anchor.setHours(0, 0, 0, 0);
  if (dayStart < anchor) return null;
  if (ev.recurringUntil) {
    const until = new Date(ev.recurringUntil); until.setHours(0, 0, 0, 0);
    if (dayStart > until) return null;
  }
  if (!weekdays.includes(dayStart.getDay())) return null;
  if ((ev.recurringExceptions || []).includes(kstDayKey(dayStart))) return null;
  const start = new Date(dayStart);
  start.setHours(ev.startTime.getHours(), ev.startTime.getMinutes(), 0, 0);
  return { start };
}

async function pushUserIds() {
  const rows = await prisma.pushToken.findMany({ select: { userId: true }, distinct: ['userId'] });
  return rows.map((r) => r.userId);
}

// 오늘 이 사람에게 이 알림을 보낼 권리를 선점 - 이미 보냈거나 꺼둔 사람이면 false
async function claim(userId, field, flag, today) {
  const res = await prisma.userEngagement.updateMany({
    where: { userId, [flag]: true, OR: [{ [field]: null }, { [field]: { not: today } }] },
    data: { [field]: today },
  });
  if (res.count > 0) return true;
  try {
    await prisma.userEngagement.create({ data: { userId, [field]: today } });
    return true;
  } catch (e) {
    return false; // 이미 줄이 있음 = 오늘 보냈거나 알림을 꺼둠
  }
}

async function runMorningBrief(now) {
  const today = kstDayKey(now);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400e3);
  const userIds = await pushUserIds();
  if (!userIds.length) return 0;

  const already = await prisma.userEngagement.findMany({
    where: { userId: { in: userIds }, OR: [{ morningBrief: false }, { lastMorningOn: today }] },
    select: { userId: true },
  });
  const skip = new Set(already.map((r) => r.userId));
  const targets = userIds.filter((id) => !skip.has(id));
  if (!targets.length) return 0;

  const events = await prisma.event.findMany({
    where: {
      userId: { in: targets },
      eventType: 'busy',
      isPendingHold: false,
      startTime: { lt: dayEnd },
      OR: [{ endTime: { gt: dayStart } }, { recurringWeekdays: { isEmpty: false } }],
    },
    select: { userId: true, title: true, startTime: true, endTime: true, recurringWeekdays: true, recurringUntil: true, recurringExceptions: true },
  });
  const byUser = new Map();
  for (const ev of events) {
    const occ = occurrenceOn(ev, dayStart);
    if (!occ) continue;
    if (!byUser.has(ev.userId)) byUser.set(ev.userId, []);
    byUser.get(ev.userId).push({ title: ev.title, start: occ.start });
  }
  if (!byUser.size) return 0;

  // 잠금화면에 일정 제목이 보이는 게 싫은 사람(채팅 미리보기 끔)에겐 제목 없이 시간만
  const hidePreview = new Set((await prisma.userSettings.findMany({
    where: { userId: { in: [...byUser.keys()] }, chatPreview: false }, select: { userId: true },
  })).map((s) => s.userId));

  let sent = 0;
  for (const [userId, list] of byUser) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await claim(userId, 'lastMorningOn', 'morningBrief', today))) continue;
    list.sort((a, b) => (a.start ? a.start.getTime() : 0) - (b.start ? b.start.getTime() : 0));
    const first = list[0];
    const when = first.start ? hm(first.start) : '종일';
    const body = hidePreview.has(userId)
      ? `오늘 일정 ${list.length}개가 있어요 · 첫 일정 ${when}`
      : `오늘 일정 ${list.length}개 · ${when} ${first.title}${list.length > 1 ? ` 외 ${list.length - 1}개` : ''}`;
    // eslint-disable-next-line no-await-in-loop
    await sendPushToUsers([userId], { title: '좋은 아침이에요 ☀️', body, data: { type: 'today' } });
    track(userId, 'push_sent', { kind: 'morning' });
    sent++;
  }
  return sent;
}

async function runWeeklyNudge(now) {
  const today = kstDayKey(now);
  // 다음 주 = 내일(월)부터 7일
  const from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() + 1);
  const to = new Date(from.getTime() + 7 * 86400e3);
  const userIds = await pushUserIds();
  if (!userIds.length) return 0;

  const already = await prisma.userEngagement.findMany({
    where: { userId: { in: userIds }, OR: [{ weeklyNudge: false }, { lastWeeklyOn: today }] },
    select: { userId: true },
  });
  const skip = new Set(already.map((r) => r.userId));
  const targets = userIds.filter((id) => !skip.has(id));
  if (!targets.length) return 0;

  const avail = await prisma.event.findMany({
    where: { userId: { in: targets }, eventType: 'available' },
    select: { userId: true, startTime: true, endTime: true, recurringWeekdays: true, recurringUntil: true, recurringExceptions: true },
  });
  const everOpened = new Set();
  const openNextWeek = new Set();
  for (const ev of avail) {
    everOpened.add(ev.userId);
    if (openNextWeek.has(ev.userId)) continue;
    for (let d = new Date(from); d < to; d = new Date(d.getTime() + 86400e3)) {
      if (occurrenceOn(ev, d)) { openNextWeek.add(ev.userId); break; }
    }
  }

  let sent = 0;
  for (const userId of targets) {
    if (openNextWeek.has(userId)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await claim(userId, 'lastWeeklyOn', 'weeklyNudge', today))) continue;
    const body = everOpened.has(userId)
      ? '다음 주에 열어둔 시간이 없어요. 요일·시간대만 고르면 30초면 다시 열 수 있어요.'
      : '다음 주에 만날 사람 있어요? 되는 시간만 열어두면 친구가 거기에 맞춰 약속을 요청해요.';
    // eslint-disable-next-line no-await-in-loop
    await sendPushToUsers([userId], { title: '다음 주 시간 열어둘까요?', body, data: { type: 'openAvail' } });
    track(userId, 'push_sent', { kind: 'weekly' });
    sent++;
  }
  return sent;
}

let running = false;
async function runEngagementTick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const result = { morning: 0, weekly: 0 };
  try {
    const h = now.getHours();
    if (h >= MORNING_HOUR && h < MORNING_UNTIL) result.morning = await runMorningBrief(now);
    if (now.getDay() === WEEKLY_DOW && h >= WEEKLY_HOUR && h < WEEKLY_UNTIL) result.weekly = await runWeeklyNudge(now);
  } catch (err) {
    // 지표/알림 테이블이 아직 DB에 없으면 여기로 옴 - 다른 기능엔 영향 없게 로그만 남김
    console.error('[engagement] tick failed:', err.message);
  } finally {
    running = false;
  }
  return result;
}

function startEngagementScheduler() {
  setInterval(() => { runEngagementTick(); }, 5 * 60 * 1000).unref();
  setTimeout(() => { runEngagementTick(); }, 30 * 1000).unref(); // 서버가 막 깨어났을 때도 한 번
}

module.exports = { runEngagementTick, startEngagementScheduler, occurrenceOn };
