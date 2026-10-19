// 정기 알림 - 앱을 다시 열 이유를 주는 두 가지.
//  1) 아침 8시: 오늘 일정이 있는 사람에게 "오늘 일정 N개 · 10:00 수업" (일정 없는 날엔 안 보냄)
//  2) 일요일 저녁 7시: 다음 주에 열어둔 예약 가능 시간이 없는 사람에게 "다음 주 시간 열어둘까요?"
//  3) 확정된 약속 1시간 전·5분 전: "1시간 뒤 약속이에요" / "5분 뒤 약속이에요" (그 약속을 잡은 채팅방 알림을 끈 사람은 제외)
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

// 약속 1시간 전 알림 - 채팅으로 확정된 약속(sourceMessageId가 있는 일정)이 곧 시작하면 각자에게 보냄.
// 틱마다 "지난번 확인 시각+1시간 ~ 지금+1시간"에 시작하는 약속만 봐서 한 번씩만 감 (서버가 재시작돼도 지난 구간은 다시 안 봄)
const REMINDER_LEAD_MS = 60 * 60 * 1000;
const SOON_REMINDER_LEAD_MS = 5 * 60 * 1000; // 5분 전 알림 - 늦지 않게 1분마다 따로 확인
const lastReminderCheck = new Map(); // 알림 종류(몇 분 전)별 지난번 확인 시각
const remindedEventIds = new Set();
async function runAppointmentReminders(now, leadMs = REMINDER_LEAD_MS) {
  const last = lastReminderCheck.get(leadMs);
  const from = new Date((last || new Date(now.getTime() - 5 * 60 * 1000)).getTime() + leadMs);
  const to = new Date(now.getTime() + leadMs);
  lastReminderCheck.set(leadMs, now);
  if (to <= from) return 0;
  const events = await prisma.event.findMany({
    where: {
      eventType: 'busy',
      isPendingHold: false,
      sourceMessageId: { not: null },
      startTime: { gt: from, lte: to },
    },
    select: { id: true, userId: true, title: true, startTime: true, sourceChatRoomId: true },
  });
  if (!events.length) return 0;
  const hidePreview = new Set((await prisma.userSettings.findMany({
    where: { userId: { in: [...new Set(events.map((e) => e.userId))] }, chatPreview: false }, select: { userId: true },
  })).map((s) => s.userId));
  // 그 약속이 잡힌 채팅방의 알림을 끈 사람에겐 안 보냄
  const mutedRooms = new Set((await prisma.chatRoomMember.findMany({
    where: { muted: true, chatRoomId: { in: [...new Set(events.map((e) => e.sourceChatRoomId).filter(Boolean))] } },
    select: { chatRoomId: true, userId: true },
  })).map((m) => `${m.chatRoomId}:${m.userId}`));
  let sent = 0;
  for (const ev of events) {
    const remindKey = `${leadMs}:${ev.id}`;
    if (remindedEventIds.has(remindKey)) continue;
    remindedEventIds.add(remindKey);
    if (ev.sourceChatRoomId && mutedRooms.has(`${ev.sourceChatRoomId}:${ev.userId}`)) continue;
    const body = hidePreview.has(ev.userId)
      ? `${hm(ev.startTime)}에 약속이 있어요`
      : `${hm(ev.startTime)} ${ev.title}`;
    // eslint-disable-next-line no-await-in-loop
    await sendPushToUsers([ev.userId], {
      title: leadMs === REMINDER_LEAD_MS ? '1시간 뒤 약속이에요 ⏰' : '5분 뒤 약속이에요 ⏰',
      body,
      data: ev.sourceChatRoomId ? { type: 'chat', roomId: ev.sourceChatRoomId } : { type: 'today' },
    });
    sent++;
  }
  if (remindedEventIds.size > 5000) remindedEventIds.clear();
  return sent;
}

// 5분 전 알림은 5분마다 도는 틱으론 늦을 수 있어서 1분마다도 따로 확인 (틱과 동시에 돌아도 한 번만 보내게 막음)
let soonRunning = false;
async function runSoonReminders(now = new Date()) {
  if (soonRunning) return 0;
  soonRunning = true;
  try {
    return await runAppointmentReminders(now, SOON_REMINDER_LEAD_MS);
  } catch (err) {
    console.error('[engagement] soon reminders failed:', err.message);
    return 0;
  } finally {
    soonRunning = false;
  }
}

let running = false;
async function runEngagementTick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const result = { morning: 0, weekly: 0, reminders: 0 };
  try {
    try {
      result.reminders = await runAppointmentReminders(now);
      result.reminders += await runSoonReminders(now);
    } catch (err) {
      console.error('[engagement] reminders failed:', err.message);
    }
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
  setInterval(() => { runSoonReminders(); }, 60 * 1000).unref();
  setTimeout(() => { runEngagementTick(); }, 30 * 1000).unref(); // 서버가 막 깨어났을 때도 한 번
}

module.exports = { runEngagementTick, startEngagementScheduler, occurrenceOn };
