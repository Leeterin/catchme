const prisma = require('../lib/prisma');

const VALID_TARGET_TYPES = ['FEED_POST', 'MEETUP', 'USER'];

// POST /api/reports   body: { targetType, targetId, reason, detail? }
// 지금은 자동으로 뭔가 처리되진 않고 기록만 남김 (나중에 관리자 화면에서 검토하는 걸 전제로 함)
async function createReport(req, res) {
  const { targetType, targetId, reason, detail } = req.body;
  if (!VALID_TARGET_TYPES.includes(targetType)) {
    return res.status(400).json({ message: '신고 대상 종류가 올바르지 않아요.' });
  }
  if (!targetId) {
    return res.status(400).json({ message: '신고 대상을 지정해주세요.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ message: '신고 사유를 선택해주세요.' });
  }
  if (targetType === 'USER' && targetId === req.userId) {
    return res.status(400).json({ message: '자기 자신은 신고할 수 없어요.' });
  }

  await prisma.report.create({
    data: {
      reporterId: req.userId,
      targetType,
      targetId,
      reason: reason.trim(),
      detail: detail ? String(detail).slice(0, 500) : null,
    },
  });

  return res.status(201).json({ message: '신고가 접수됐어요. 검토 후 조치할게요.' });
}

// GET /api/reports/trust/:userId
// 아주 단순한 신뢰 지표 - "노쇼" 사유로 접수된 신고가 일정 건수 이상이면 알려줌.
// (자동으로 뭔가 제재하진 않고, 다른 사람이 참고할 수 있게 살짝 표시만 해줌)
async function getTrustInfo(req, res) {
  const { userId } = req.params;
  const noShowCount = await prisma.report.count({
    where: { targetType: 'USER', targetId: userId, reason: '노쇼' },
  });
  return res.json({ noShowCount, hasNoShowHistory: noShowCount >= 2 });
}

module.exports = { createReport, getTrustInfo };
