const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');

const router = express.Router();

router.use(requireAuth);

// POST /api/push/tokens   body: { token, platform } - 이 기기를 내 계정의 푸시 수신 기기로 등록
router.post('/tokens', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const platform = req.body.platform === 'ios' ? 'ios' : 'android';
  if (!token || token.length > 4096) return res.status(400).json({ message: '토큰이 올바르지 않아요.' });
  // 같은 기기에서 다른 계정으로 로그인하면 토큰 주인을 새 계정으로 옮김
  await prisma.pushToken.upsert({
    where: { token },
    create: { token, platform, userId: req.userId },
    update: { platform, userId: req.userId },
  });
  res.json({ ok: true });
});

// DELETE /api/push/tokens   body: { token } - 로그아웃 시 이 기기로 더 이상 안 보내게
router.delete('/tokens', async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (token) await prisma.pushToken.deleteMany({ where: { token, userId: req.userId } });
  res.json({ ok: true });
});

module.exports = router;
