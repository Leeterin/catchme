const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');

// 홈 "이번 달 목표" - 운동·책 읽기처럼 한 달에 몇 번 할지 정하고 직접 [+1]을 눌러서 셈
const router = express.Router();
router.use(requireAuth);

const MAX_GOALS = 10;
const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
function cleanTitle(t) { return typeof t === 'string' ? t.trim().slice(0, 30) : ''; }
function cleanTarget(n) { const v = Math.round(Number(n)); return Number.isFinite(v) && v >= 1 && v <= 999 ? v : null; }

async function ownGoal(req, res) {
  const goal = await prisma.monthlyGoal.findUnique({ where: { id: req.params.id } });
  if (!goal || goal.userId !== req.userId) { res.status(404).json({ message: '목표를 찾을 수 없어요.' }); return null; }
  return goal;
}

// GET /api/goals?month=YYYY-MM - 내 목표 목록 + 그 달에 누른 횟수
router.get('/', async (req, res) => {
  const month = req.query.month;
  if (!isMonth(month)) return res.status(400).json({ message: '달(month)이 올바르지 않아요.' });
  const goals = await prisma.monthlyGoal.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'asc' },
    include: { counts: { where: { month } } },
  });
  res.json({ goals: goals.map((g) => ({ id: g.id, title: g.title, target: g.target, count: g.counts[0] ? g.counts[0].count : 0 })) });
});

// POST /api/goals  { title, target }
router.post('/', writeLimiter, async (req, res) => {
  const title = cleanTitle(req.body.title);
  const target = cleanTarget(req.body.target);
  if (!title) return res.status(400).json({ message: '목표 이름을 적어주세요.' });
  if (!target) return res.status(400).json({ message: '횟수는 1~999 사이로 정해주세요.' });
  const n = await prisma.monthlyGoal.count({ where: { userId: req.userId } });
  if (n >= MAX_GOALS) return res.status(400).json({ message: `목표는 ${MAX_GOALS}개까지 만들 수 있어요.` });
  const g = await prisma.monthlyGoal.create({ data: { userId: req.userId, title, target } });
  res.status(201).json({ goal: { id: g.id, title: g.title, target: g.target, count: 0 } });
});

// PATCH /api/goals/:id  { title?, target? }
router.patch('/:id', writeLimiter, async (req, res) => {
  const goal = await ownGoal(req, res); if (!goal) return;
  const data = {};
  if (req.body.title !== undefined) { const t = cleanTitle(req.body.title); if (!t) return res.status(400).json({ message: '목표 이름을 적어주세요.' }); data.title = t; }
  if (req.body.target !== undefined) { const v = cleanTarget(req.body.target); if (!v) return res.status(400).json({ message: '횟수는 1~999 사이로 정해주세요.' }); data.target = v; }
  const g = await prisma.monthlyGoal.update({ where: { id: goal.id }, data });
  res.json({ goal: { id: g.id, title: g.title, target: g.target } });
});

// DELETE /api/goals/:id
router.delete('/:id', async (req, res) => {
  const goal = await ownGoal(req, res); if (!goal) return;
  await prisma.monthlyGoal.delete({ where: { id: goal.id } });
  res.json({ ok: true });
});

// POST /api/goals/:id/count  { month, delta: 1 | -1 } - 직접 누른 횟수 올리기/되돌리기 (0 밑으로는 안 내려감)
router.post('/:id/count', async (req, res) => {
  const goal = await ownGoal(req, res); if (!goal) return;
  const { month } = req.body;
  const delta = req.body.delta === -1 ? -1 : 1;
  if (!isMonth(month)) return res.status(400).json({ message: '달(month)이 올바르지 않아요.' });
  const key = { goalId_month: { goalId: goal.id, month } };
  try {
    await prisma.monthlyGoalCount.upsert({ where: key, update: {}, create: { goalId: goal.id, month, count: 0 } });
  } catch (err) {
    if (err.code !== 'P2002') throw err; // 그 달 첫 [+1]을 빠르게 두 번 누르면 다른 요청이 먼저 만들어둠 - 그대로 이어서 셈
  }
  // 읽고 나서 새 값을 쓰면 빠르게 여러 번 누를 때 횟수가 사라져서(4번 눌러도 2), DB에서 바로 더하고 뺌
  if (delta === 1) {
    await prisma.monthlyGoalCount.update({ where: key, data: { count: { increment: 1 } } });
  } else {
    await prisma.monthlyGoalCount.updateMany({ where: { goalId: goal.id, month, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
  }
  const saved = await prisma.monthlyGoalCount.findUnique({ where: key });
  res.json({ count: saved.count });
});

module.exports = router;
