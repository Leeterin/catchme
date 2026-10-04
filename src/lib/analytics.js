// 사용 지표 기록 - 가입 후 첫 일정/첫 링크까지 가는지(활성화), 다음 날·일주일 뒤 다시 오는지(재방문)를 보려고 남김.
// 기록이 실패해도(예: 지표 테이블이 아직 DB에 없음) 원래 기능은 절대 막지 않게, 전부 기다리지 않고 조용히 넘어감.
const prisma = require('./prisma');

// 한국 날짜 "YYYY-MM-DD" (서버는 TZ=Asia/Seoul로 돌아감)
function kstDayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function track(userId, name, props) {
  prisma.analyticsEvent.create({ data: { userId: userId || null, name, props: props || undefined } })
    .catch(() => {});
}

// 같은 사람·같은 날은 한 번만 DB에 씀 (요청마다 쓰면 낭비라 메모리에 오늘 기록했는지 기억해둠)
const activeSeen = new Map();
function markActive(userId) {
  if (!userId) return;
  const day = kstDayKey();
  if (activeSeen.get(userId) === day) return;
  activeSeen.set(userId, day);
  if (activeSeen.size > 50000) activeSeen.clear();
  prisma.userActiveDay.createMany({ data: [{ userId, day }], skipDuplicates: true })
    .catch(() => { activeSeen.delete(userId); });
}

module.exports = { track, markActive, kstDayKey };
