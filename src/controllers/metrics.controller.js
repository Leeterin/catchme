// 관리자 "지표" 탭 - 새로 온 사람이 실제로 쓰기 시작하는지(활성화), 다시 오는지(재방문)를 숫자로 봄.
// 일정/링크/친구는 원래 테이블에서 바로 세고, 재방문·캘린더 불러오기는 지표 테이블(user_active_days, analytics_events)에서 셈.
// 지표 테이블이 아직 DB에 없으면 그 항목만 null로 돌려줌 (나머지는 정상 표시)
const prisma = require('../lib/prisma');

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 가입 시각("createdAt") 기준 KST 날짜
const SIGNUP_DAY = `(u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date`;

async function safeQuery(sql, ...params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    return null;
  }
}

// GET /api/admin/metrics?start=YYYY-MM-DD&end=YYYY-MM-DD  (가입일 기준 코호트, 기본 최근 30일)
async function getMetrics(req, res) {
  const today = kstToday();
  let end = DATE_ONLY_RE.test(req.query.end) ? req.query.end : today;
  let start = DATE_ONLY_RE.test(req.query.start) ? req.query.start : addDays(end, -29);
  if (start > end) [start, end] = [end, start];

  const cohortWhere = `${SIGNUP_DAY} BETWEEN $1::date AND $2::date`;

  // 1) 원래 테이블로 셀 수 있는 활성화 단계
  const base = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS signups,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM events e WHERE e."userId" = u.id AND e."sourceChatRoomId" IS NULL AND e."isPendingHold" = false
           AND e."eventType" = 'busy' AND e."createdAt" < u."createdAt" + interval '1 day'))::int AS first_event_1d,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM events e WHERE e."userId" = u.id AND e."eventType" = 'available'
           AND e."createdAt" < u."createdAt" + interval '7 days'))::int AS available_7d,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM invite_polls p WHERE p."creatorId" = u.id AND p."createdAt" < u."createdAt" + interval '7 days'))::int AS invite_7d,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM friend_requests f WHERE (f."senderId" = u.id OR f."receiverId" = u.id) AND f.status = 'ACCEPTED'
           AND COALESCE(f."respondedAt", f."createdAt") < u."createdAt" + interval '7 days'))::int AS friend_7d
     FROM users u WHERE ${cohortWhere}`,
    start, end,
  );

  // 2) 지표 테이블이 필요한 것 - 캘린더 불러오기, 재방문(D1/D7)
  const extra = await safeQuery(
    `SELECT
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM analytics_events a WHERE a."userId" = u.id AND a.name = 'calendar_import'
           AND a."createdAt" < u."createdAt" + interval '7 days'))::int AS import_7d,
       COUNT(*) FILTER (WHERE ${SIGNUP_DAY} + 1 <= $3::date)::int AS d1_eligible,
       COUNT(*) FILTER (WHERE ${SIGNUP_DAY} + 1 <= $3::date AND EXISTS (
         SELECT 1 FROM user_active_days d WHERE d."userId" = u.id AND d.day = to_char(${SIGNUP_DAY} + 1, 'YYYY-MM-DD')))::int AS d1,
       COUNT(*) FILTER (WHERE ${SIGNUP_DAY} + 7 <= $3::date)::int AS d7_eligible,
       COUNT(*) FILTER (WHERE ${SIGNUP_DAY} + 7 <= $3::date AND EXISTS (
         SELECT 1 FROM user_active_days d WHERE d."userId" = u.id AND d.day = to_char(${SIGNUP_DAY} + 7, 'YYYY-MM-DD')))::int AS d7,
       COUNT(*) FILTER (WHERE ${SIGNUP_DAY} + 7 <= $3::date AND EXISTS (
         SELECT 1 FROM user_active_days d WHERE d."userId" = u.id
           AND d.day > to_char(${SIGNUP_DAY}, 'YYYY-MM-DD') AND d.day <= to_char(${SIGNUP_DAY} + 7, 'YYYY-MM-DD')))::int AS w1
     FROM users u WHERE ${cohortWhere}`,
    start, end, today,
  );

  // 3) 최근 14일 일별 - 가입, 활성 사용자, 일정, 링크, 링크 응답
  const dailyStart = addDays(today, -13);
  const daily = await prisma.$queryRawUnsafe(
    `SELECT to_char(gs::date, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*) FROM users u WHERE ${SIGNUP_DAY} = gs::date)::int AS signups,
       (SELECT COUNT(*) FROM events e WHERE (e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date = gs::date
          AND e."sourceChatRoomId" IS NULL AND e."isPendingHold" = false)::int AS events,
       (SELECT COUNT(*) FROM invite_polls p WHERE (p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date = gs::date)::int AS invites,
       (SELECT COUNT(*) FROM invite_responses r WHERE (r."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date = gs::date)::int AS responses
     FROM generate_series($1::date, $2::date, interval '1 day') gs ORDER BY gs`,
    dailyStart, today,
  );
  const dau = await safeQuery(
    `SELECT day, COUNT(*)::int AS n FROM user_active_days WHERE day BETWEEN $1 AND $2 GROUP BY day`,
    dailyStart, today,
  );
  const dauMap = dau ? Object.fromEntries(dau.map((r) => [r.day, r.n])) : null;

  const b = base[0] || {};
  const x = extra && extra[0];
  res.json({
    range: { start, end },
    trackingReady: !!x,
    cohort: {
      signups: b.signups || 0,
      firstEvent1d: b.first_event_1d || 0,
      import7d: x ? x.import_7d : null,
      available7d: b.available_7d || 0,
      invite7d: b.invite_7d || 0,
      friend7d: b.friend_7d || 0,
      d1: x ? { n: x.d1, of: x.d1_eligible } : null,
      d7: x ? { n: x.d7, of: x.d7_eligible } : null,
      w1: x ? { n: x.w1, of: x.d7_eligible } : null,
    },
    daily: daily.map((r) => ({ ...r, active: dauMap ? (dauMap[r.day] || 0) : null })),
  });
}

module.exports = { getMetrics };
