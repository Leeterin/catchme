const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth.middleware');
const { track } = require('../lib/analytics');

const router = express.Router();
router.use(requireAuth);

// GET /api/engagement/prefs - 정기 알림(아침 오늘 일정 / 일요일 다음 주 시간) 켜짐 여부
router.get('/prefs', async (req, res) => {
  try {
    const row = await prisma.userEngagement.findUnique({ where: { userId: req.userId } });
    res.json({ morningBrief: row ? row.morningBrief : true, weeklyNudge: row ? row.weeklyNudge : true });
  } catch (err) {
    res.json({ morningBrief: true, weeklyNudge: true }); // 테이블이 아직 없어도 화면은 기본값으로
  }
});

// PATCH /api/engagement/prefs  { morningBrief?, weeklyNudge? }
router.patch('/prefs', async (req, res) => {
  const data = {};
  if (typeof req.body.morningBrief === 'boolean') data.morningBrief = req.body.morningBrief;
  if (typeof req.body.weeklyNudge === 'boolean') data.weeklyNudge = req.body.weeklyNudge;
  try {
    const row = await prisma.userEngagement.upsert({
      where: { userId: req.userId },
      update: data,
      create: { userId: req.userId, ...data },
    });
    res.json({ morningBrief: row.morningBrief, weeklyNudge: row.weeklyNudge });
  } catch (err) {
    res.status(503).json({ message: '알림 설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
});

// POST /api/engagement/track  { name, props? } - 화면에서만 알 수 있는 행동 기록 (정해진 이름만 받음)
const CLIENT_EVENTS = new Set([
  'push_open', 'import_opened', 'invite_prompt_shown', 'invite_prompt_click', 'invite_link_shared',
]);
router.post('/track', (req, res) => {
  const name = String(req.body.name || '');
  if (!CLIENT_EVENTS.has(name)) return res.status(400).json({ message: '알 수 없는 기록이에요.' });
  const props = req.body.props && typeof req.body.props === 'object' && !Array.isArray(req.body.props)
    ? Object.fromEntries(Object.entries(req.body.props).slice(0, 5).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 60)]))
    : undefined;
  track(req.userId, name, props);
  res.status(204).end();
});

module.exports = router;
