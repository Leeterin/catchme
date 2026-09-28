const prisma = require('../lib/prisma');

// GET /api/admin/overview - 대시보드용 요약 통계
async function getOverview(req, res) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

  const [
    totalUsers, newUsersThisWeek, suspendedUsers,
    totalFeedPosts, totalMeetups, activeMeetups,
    totalMessages, messagesToday,
    pendingReports, totalReports,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { isSuspended: true } }),
    prisma.feedPost.count(),
    prisma.meetup.count(),
    prisma.meetup.count({ where: { cancelled: false } }),
    prisma.message.count(),
    prisma.message.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.report.count({ where: { status: 'PENDING' } }),
    prisma.report.count(),
  ]);

  return res.json({
    users: { total: totalUsers, newThisWeek: newUsersThisWeek, suspended: suspendedUsers },
    feedPosts: { total: totalFeedPosts },
    meetups: { total: totalMeetups, active: activeMeetups },
    messages: { total: totalMessages, today: messagesToday },
    reports: { pending: pendingReports, total: totalReports },
  });
}

// 목록/상세 응답에 비밀번호 등 민감정보 없이 내려주는 유저 모양
function serializeAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    profileImageUrl: user.profileImageUrl,
    isSuspended: user.isSuspended,
    suspendedReason: user.suspendedReason,
    suspendedAt: user.suspendedAt,
    createdAt: user.createdAt,
    counts: user._count ? {
      feedPosts: user._count.feedPosts,
      meetups: user._count.createdMeetups,
      reportsMade: user._count.reportsMade,
    } : undefined,
  };
}

// GET /api/admin/users?q=&page=&limit=&filter=(all|suspended)
async function listUsers(req, res) {
  const q = String(req.query.q || '').trim();
  const filter = req.query.filter === 'suspended' ? 'suspended' : 'all';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

  const where = {
    ...(filter === 'suspended' ? { isSuspended: true } : {}),
    ...(q ? {
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        _count: { select: { feedPosts: true, createdMeetups: true, reportsMade: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return res.json({
    users: users.map(serializeAdminUser),
    page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// GET /api/admin/users/:id
async function getUserDetail(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { feedPosts: true, createdMeetups: true, reportsMade: true } },
    },
  });
  if (!user) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });
  return res.json({ user: serializeAdminUser(user) });
}

// POST /api/admin/users/:id/suspend   body: { reason }
async function suspendUser(req, res) {
  const { id } = req.params;
  const { reason } = req.body;

  const target = await prisma.user.findUnique({ where: { id }, select: { email: true, username: true } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  const user = await prisma.user.update({
    where: { id },
    data: {
      isSuspended: true,
      suspendedReason: reason ? String(reason).trim().slice(0, 300) : null,
      suspendedAt: new Date(),
    },
  });

  // 정지된 계정은 현재 로그인 세션도 전부 끊어서, 이미 로그인돼있어도 다음 요청부터 다시 로그인해야 함
  await prisma.refreshToken.deleteMany({ where: { userId: id } });

  return res.json({ message: '계정을 정지시켰어요.', user: serializeAdminUser(user) });
}

// POST /api/admin/users/:id/unsuspend
async function unsuspendUser(req, res) {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  const user = await prisma.user.update({
    where: { id },
    data: { isSuspended: false, suspendedReason: null, suspendedAt: null },
  });

  return res.json({ message: '정지를 해제했어요.', user: serializeAdminUser(user) });
}

// DELETE /api/admin/users/:id - 계정 완전 삭제 (되돌릴 수 없음)
// 이 사람이 만든 약속방(MatchingRoom)이 있으면 FK 제약으로 삭제가 막힐 수 있어서, 그런 경우엔
// 안내 메시지로 알려주고 대신 정지를 권함 (무리하게 연쇄삭제하면 다른 사람 데이터까지 날아갈 수 있어서 안전하게 처리)
async function deleteUser(req, res) {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  try {
    await prisma.user.delete({ where: { id } });
    return res.json({ message: '계정을 삭제했어요.' });
  } catch (err) {
    if (err.code === 'P2003') {
      return res.status(409).json({
        message: '이 유저가 만든 다른 데이터(약속방 등) 때문에 완전히 삭제할 수 없어요. 대신 계정 정지를 사용해주세요.',
      });
    }
    console.error('[deleteUser] error:', err);
    return res.status(500).json({ message: '삭제 처리 중 오류가 발생했어요.' });
  }
}

// 신고 대상(targetType/targetId)의 실제 내용을 조회해서 신고 목록에 같이 보여줌 -
// Report가 여러 종류(FEED_POST/MEETUP/USER)를 하나의 targetId로 느슨하게 참조하고 있어서 직접 조회함
async function resolveTargetPreview(report) {
  try {
    if (report.targetType === 'FEED_POST') {
      const post = await prisma.feedPost.findUnique({
        where: { id: report.targetId },
        select: { id: true, title: true, note: true, author: { select: { id: true, username: true, name: true } } },
      });
      return post ? { exists: true, title: post.title || post.note || '(제목 없음)', author: post.author } : { exists: false };
    }
    if (report.targetType === 'MEETUP') {
      const meetup = await prisma.meetup.findUnique({
        where: { id: report.targetId },
        select: { id: true, title: true, creator: { select: { id: true, username: true, name: true } } },
      });
      return meetup ? { exists: true, title: meetup.title, author: meetup.creator } : { exists: false };
    }
    if (report.targetType === 'USER') {
      const user = await prisma.user.findUnique({
        where: { id: report.targetId },
        select: { id: true, username: true, name: true },
      });
      return user ? { exists: true, title: `@${user.username}`, author: user } : { exists: false };
    }
  } catch (err) {
    console.error('[resolveTargetPreview] error:', err);
  }
  return { exists: false };
}

// GET /api/admin/reports?status=PENDING&page=&limit=
async function listReports(req, res) {
  const status = ['PENDING', 'REVIEWED', 'DISMISSED'].includes(req.query.status) ? req.query.status : 'PENDING';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { reporter: { select: { id: true, username: true, name: true } } },
    }),
    prisma.report.count({ where: { status } }),
  ]);

  const withTargets = await Promise.all(reports.map(async (r) => ({
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    createdAt: r.createdAt,
    reporter: r.reporter,
    target: await resolveTargetPreview(r),
  })));

  return res.json({
    reports: withTargets, page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// POST /api/admin/reports/:id/resolve   body: { action: 'DISMISS' | 'SUSPEND_USER' | 'DELETE_CONTENT', reason? }
async function resolveReport(req, res) {
  const { id } = req.params;
  const { action, reason } = req.body;

  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return res.status(404).json({ message: '신고를 찾을 수 없어요.' });

  if (action === 'DISMISS') {
    await prisma.report.update({ where: { id }, data: { status: 'DISMISSED' } });
    return res.json({ message: '신고를 반려 처리했어요.' });
  }

  if (action === 'SUSPEND_USER') {
    if (report.targetType !== 'USER') {
      return res.status(400).json({ message: '유저 신고가 아니에요.' });
    }
    await prisma.user.update({
      where: { id: report.targetId },
      data: { isSuspended: true, suspendedReason: reason ? String(reason).trim().slice(0, 300) : '신고 접수', suspendedAt: new Date() },
    }).catch(() => null);
    await prisma.refreshToken.deleteMany({ where: { userId: report.targetId } });
    await prisma.report.update({ where: { id }, data: { status: 'REVIEWED' } });
    return res.json({ message: '해당 계정을 정지시키고 신고를 처리했어요.' });
  }

  if (action === 'DELETE_CONTENT') {
    if (report.targetType === 'FEED_POST') {
      await prisma.feedPost.delete({ where: { id: report.targetId } }).catch(() => null);
    } else if (report.targetType === 'MEETUP') {
      await prisma.meetup.delete({ where: { id: report.targetId } }).catch(() => null);
    } else {
      return res.status(400).json({ message: '이 신고 대상은 콘텐츠 삭제 대상이 아니에요.' });
    }
    await prisma.report.update({ where: { id }, data: { status: 'REVIEWED' } });
    return res.json({ message: '신고된 콘텐츠를 삭제하고 신고를 처리했어요.' });
  }

  return res.status(400).json({ message: '올바르지 않은 처리 방식이에요.' });
}

module.exports = {
  getOverview, listUsers, getUserDetail, suspendUser, unsuspendUser, deleteUser,
  listReports, resolveReport,
};
