const prisma = require('../lib/prisma');

// 관리자 행동 기록 - 실패해도(로그 자체 오류) 원래 하려던 작업까지 막지는 않도록 에러를 삼킴
async function logAdminAction(actorId, action, { targetType, targetId, detail } = {}) {
  try {
    await prisma.adminActionLog.create({
      data: { actorId, action, targetType: targetType || null, targetId: targetId || null, detail: detail || null },
    });
  } catch (err) {
    console.error('[logAdminAction] error:', err);
  }
}

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

// ------------------------------------------------------------
// 유저 관리
// ------------------------------------------------------------
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
      include: { _count: { select: { feedPosts: true, createdMeetups: true, reportsMade: true } } },
    }),
    prisma.user.count({ where }),
  ]);

  return res.json({
    users: users.map(serializeAdminUser),
    page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// POST /api/admin/users/:id/suspend   body: { reason }
async function suspendUser(req, res) {
  const { id } = req.params;
  const { reason } = req.body;

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  const trimmedReason = reason ? String(reason).trim().slice(0, 300) : null;
  const user = await prisma.user.update({
    where: { id },
    data: { isSuspended: true, suspendedReason: trimmedReason, suspendedAt: new Date() },
  });

  // 정지된 계정은 현재 로그인 세션도 전부 끊어서, 이미 로그인돼있어도 다음 요청부터 다시 로그인해야 함
  await prisma.refreshToken.deleteMany({ where: { userId: id } });
  await logAdminAction(req.userId, 'SUSPEND_USER', { targetType: 'USER', targetId: id, detail: `@${target.username}${trimmedReason ? ` - ${trimmedReason}` : ''}` });

  return res.json({ message: '계정을 정지시켰어요.', user: serializeAdminUser(user) });
}

// POST /api/admin/users/:id/unsuspend
async function unsuspendUser(req, res) {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  const user = await prisma.user.update({
    where: { id },
    data: { isSuspended: false, suspendedReason: null, suspendedAt: null },
  });
  await logAdminAction(req.userId, 'UNSUSPEND_USER', { targetType: 'USER', targetId: id, detail: `@${target.username}` });

  return res.json({ message: '정지를 해제했어요.', user: serializeAdminUser(user) });
}

// DELETE /api/admin/users/:id - 계정 완전 삭제 (되돌릴 수 없음)
async function deleteUser(req, res) {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true } });
  if (!target) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  try {
    await prisma.user.delete({ where: { id } });
    await logAdminAction(req.userId, 'DELETE_USER', { targetType: 'USER', targetId: id, detail: `@${target.username}` });
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

// ------------------------------------------------------------
// 신고 처리
// ------------------------------------------------------------
async function resolveTargetPreview(report) {
  if (report.targetType === 'BUG') {
    return { exists: true, title: report.reason };
  }
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

  // 앱 오류 신고는 지울 콘텐츠/정지할 유저가 없어서 "확인 완료"로만 처리함
  if (action === 'MARK_REVIEWED') {
    await prisma.report.update({ where: { id }, data: { status: 'REVIEWED' } });
    await logAdminAction(req.userId, 'RESOLVE_REPORT', { targetType: 'REPORT', targetId: id, detail: '확인 완료' });
    return res.json({ message: '확인 완료로 처리했어요.' });
  }

  if (action === 'DISMISS') {
    await prisma.report.update({ where: { id }, data: { status: 'DISMISSED' } });
    await logAdminAction(req.userId, 'RESOLVE_REPORT', { targetType: 'REPORT', targetId: id, detail: '반려' });
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
    await logAdminAction(req.userId, 'RESOLVE_REPORT', { targetType: 'REPORT', targetId: id, detail: '유저 정지' });
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
    await logAdminAction(req.userId, 'RESOLVE_REPORT', { targetType: 'REPORT', targetId: id, detail: '콘텐츠 삭제' });
    return res.json({ message: '신고된 콘텐츠를 삭제하고 신고를 처리했어요.' });
  }

  return res.status(400).json({ message: '올바르지 않은 처리 방식이에요.' });
}

// ------------------------------------------------------------
// 소식(피드) 게시물 관리 - 신고 없이도 직접 검색해서 삭제 가능
// ------------------------------------------------------------
// GET /api/admin/feed-posts?q=&page=&limit=
async function listFeedPosts(req, res) {
  const q = String(req.query.q || '').trim();
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

  const where = q ? {
    OR: [
      { title: { contains: q, mode: 'insensitive' } },
      { note: { contains: q, mode: 'insensitive' } },
      { location: { contains: q, mode: 'insensitive' } },
      { author: { is: { username: { contains: q, mode: 'insensitive' } } } },
    ],
  } : {};

  const [posts, total] = await Promise.all([
    prisma.feedPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        author: { select: { id: true, username: true, name: true } },
        _count: { select: { likes: true, comments: true } },
      },
    }),
    prisma.feedPost.count({ where }),
  ]);

  return res.json({
    posts: posts.map((p) => ({
      id: p.id,
      category: p.category,
      title: p.title,
      note: p.note,
      location: p.location,
      rating: p.rating,
      photoCount: (p.photos || []).length,
      createdAt: p.createdAt,
      author: p.author,
      likeCount: p._count.likes,
      commentCount: p._count.comments,
    })),
    page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// ------------------------------------------------------------
// 소식 게시물 상세보기 - 목록에서는 요약만 보이던 게시물을 사진/댓글까지 자세히 보여줌
// ------------------------------------------------------------
// GET /api/admin/feed-posts/:id
async function getFeedPostDetail(req, res) {
  const { id } = req.params;

  const post = await prisma.feedPost.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, username: true, name: true, email: true } },
      _count: { select: { likes: true, comments: true } },
    },
  });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });

  const [comments, reportsCount, reports] = await Promise.all([
    prisma.feedPostComment.findMany({
      where: { postId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { author: { select: { id: true, username: true, name: true } } },
    }),
    prisma.report.count({ where: { targetType: 'FEED_POST', targetId: id } }),
    prisma.report.findMany({
      where: { targetType: 'FEED_POST', targetId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { reporter: { select: { username: true } } },
    }),
  ]);

  return res.json({
    post: {
      id: post.id,
      category: post.category,
      title: post.title,
      note: post.note,
      location: post.location,
      address: post.address,
      phone: post.phone,
      lat: post.lat,
      lon: post.lon,
      rating: post.rating,
      photos: post.photos || [],
      createdAt: post.createdAt,
      author: post.author,
      likeCount: post._count.likes,
      commentCount: post._count.comments,
      reportsCount,
    },
    comments: comments.map((c) => ({
      id: c.id,
      text: c.text,
      rating: c.rating,
      createdAt: c.createdAt,
      author: c.author,
    })),
    reports: reports.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
      reporterUsername: r.reporter.username,
    })),
  });
}

// DELETE /api/admin/feed-posts/:id
async function deleteFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id }, select: { id: true, title: true, note: true } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });

  await prisma.feedPost.delete({ where: { id } });
  await logAdminAction(req.userId, 'DELETE_FEED_POST', { targetType: 'FEED_POST', targetId: id, detail: post.title || post.note || null });

  return res.json({ message: '게시물을 삭제했어요.' });
}

// ------------------------------------------------------------
// 모임 관리 - 신고 없이도 직접 강제 취소 가능
// ------------------------------------------------------------
// GET /api/admin/meetups?q=&page=&limit=&filter=(all|active|cancelled)
async function listMeetups(req, res) {
  const q = String(req.query.q || '').trim();
  const filter = ['active', 'cancelled'].includes(req.query.filter) ? req.query.filter : 'all';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

  const where = {
    ...(filter === 'active' ? { cancelled: false } : filter === 'cancelled' ? { cancelled: true } : {}),
    ...(q ? {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { location: { contains: q, mode: 'insensitive' } },
        { creator: { is: { username: { contains: q, mode: 'insensitive' } } } },
      ],
    } : {}),
  };

  const [meetups, total] = await Promise.all([
    prisma.meetup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        creator: { select: { id: true, username: true, name: true } },
        _count: { select: { participants: true } },
      },
    }),
    prisma.meetup.count({ where }),
  ]);

  return res.json({
    meetups: meetups.map((m) => ({
      id: m.id,
      title: m.title,
      category: m.category,
      location: m.location,
      dateLabel: m.dateLabel,
      timeLabel: m.timeLabel,
      cancelled: m.cancelled,
      participantCount: m._count.participants,
      maxParticipants: m.maxParticipants,
      creator: m.creator,
      createdAt: m.createdAt,
    })),
    page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// POST /api/admin/meetups/:id/cancel
async function cancelMeetup(req, res) {
  const { id } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id }, select: { id: true, title: true, cancelled: true } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.cancelled) return res.status(400).json({ message: '이미 취소된 모임이에요.' });

  await prisma.meetup.update({ where: { id }, data: { cancelled: true } });
  await logAdminAction(req.userId, 'CANCEL_MEETUP', { targetType: 'MEETUP', targetId: id, detail: meetup.title });

  return res.json({ message: '모임을 취소시켰어요. (채팅방은 그대로 유지돼요)' });
}

// ------------------------------------------------------------
// 관리자 행동 로그
// ------------------------------------------------------------
// GET /api/admin/logs?page=&limit=
async function listAdminLogs(req, res) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

  const [logs, total] = await Promise.all([
    prisma.adminActionLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { actor: { select: { username: true, name: true } } },
    }),
    prisma.adminActionLog.count(),
  ]);

  return res.json({
    logs: logs.map((l) => ({
      id: l.id,
      action: l.action,
      targetType: l.targetType,
      targetId: l.targetId,
      detail: l.detail,
      actor: l.actor,
      createdAt: l.createdAt,
    })),
    page, limit, total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  });
}

// ------------------------------------------------------------
// 대시보드 그래프 - 날짜별 증감 추이
// ------------------------------------------------------------
// metric 이름은 외부 입력을 테이블명에 직접 꽂지 않기 위한 허용 목록(allowlist).
// req.query.metric 값은 반드시 이 객체의 키 중 하나여야만 통과함 - raw SQL injection 방지.
const STATS_METRICS = {
  feedPosts: 'feed_posts', // 소식 게시물
  users: 'users', // 신규 가입
  meetups: 'meetups', // 모임 생성
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' 문자열끼리의 날짜 연산 - 실제 시간대 변환 없이 순수 달력 날짜로만 계산
// (UTC 자정으로 고정해서 계산하면 DST 같은 거 신경 안 써도 됨 - 어차피 날짜 덧셈/뺄셈만 할 거라서)
function addDaysToDateString(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function daysBetweenDateStrings(startStr, endStr) {
  const a = new Date(`${startStr}T00:00:00Z`);
  const b = new Date(`${endStr}T00:00:00Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
function todayKstDateString() {
  // 한국 시간 기준 "오늘" 날짜를 'YYYY-MM-DD'로 - 서버가 UTC로 돌아도 정확하게 나오게 Intl로 계산
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

// GET /api/admin/stats/daily?metric=feedPosts&start=2026-09-01&end=2026-10-03
// 지정한 기간(기본 최근 30일, 한국 시간 기준) 동안 날짜별 생성 건수를 돌려줌.
// 데이터가 없는 날짜도 0건으로 채워서 연속된 날짜 배열로 반환 - 프론트에서 그래프 그리기 편하게.
async function getDailyStats(req, res) {
  const metric = String(req.query.metric || 'feedPosts');
  const table = STATS_METRICS[metric];
  if (!table) {
    return res.status(400).json({
      message: `metric은 ${Object.keys(STATS_METRICS).join(', ')} 중 하나여야 해요.`,
    });
  }

  const todayKst = todayKstDateString();
  let endDay = DATE_ONLY_RE.test(req.query.end) ? req.query.end : todayKst;
  let startDay = DATE_ONLY_RE.test(req.query.start) ? req.query.start : addDaysToDateString(endDay, -29);

  if (startDay > endDay) {
    [startDay, endDay] = [endDay, startDay];
  }

  // 기간을 너무 넓게 잡으면(1년 초과) 그래프도 의미 없고 쿼리 부담만 커지므로 최대 1년으로 제한
  const MAX_RANGE_DAYS = 366;
  if (daysBetweenDateStrings(startDay, endDay) > MAX_RANGE_DAYS) {
    startDay = addDaysToDateString(endDay, -MAX_RANGE_DAYS);
  }

  // table은 위 allowlist(STATS_METRICS)에서만 나온 값이라 사용자 입력이 직접 SQL에 꽂히지 않음 -
  // 날짜 범위($1, $2)는 파라미터 바인딩으로 전달. generate_series로 데이터 없는 날짜도 0건으로 채움.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT gs::date AS day, COALESCE(c.count, 0)::int AS count
     FROM generate_series($1::date, $2::date, interval '1 day') AS gs
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS count
       FROM ${table}
       WHERE (("createdAt" AT TIME ZONE 'Asia/Seoul')::date) = gs::date
     ) c ON true
     ORDER BY gs ASC`,
    startDay,
    endDay,
  );

  // Prisma 쿼리 엔진이 date 컬럼을 Date 객체로 주는지 문자열로 주는지 환경에 따라 다를 수 있어서 둘 다 대응
  const days = rows.map((r) => ({
    date: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    count: r.count,
  }));
  const total = days.reduce((sum, d) => sum + d.count, 0);

  return res.json({ metric, start: startDay, end: endDay, total, days });
}

// ------------------------------------------------------------
// 유저 상세보기 - 신고 조사할 때 여러 탭 왔다갔다 안 하고 한 화면에서 보려고 만듦
// ------------------------------------------------------------
// GET /api/admin/users/:id
async function getUserDetail(req, res) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, username: true, name: true, bio: true, phone: true,
      profileImageUrl: true, isSuspended: true, suspendedReason: true, suspendedAt: true,
      createdAt: true,
      _count: { select: { feedPosts: true, createdMeetups: true, meetupJoins: true, reportsMade: true } },
    },
  });
  if (!user) return res.status(404).json({ message: '유저를 찾을 수 없어요.' });

  // Report는 신고 대상이 USER/FEED_POST/MEETUP을 다 가리킬 수 있는 polymorphic 구조라
  // 외래키 관계로 바로 못 가져오고, targetType+targetId로 직접 조회해야 함
  const [recentPosts, reportsAgainstCount, reportsAgainst] = await Promise.all([
    prisma.feedPost.findMany({
      where: { authorId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, note: true, category: true, createdAt: true },
    }),
    prisma.report.count({ where: { targetType: 'USER', targetId: id } }),
    prisma.report.findMany({
      where: { targetType: 'USER', targetId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { reporter: { select: { username: true } } },
    }),
  ]);

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      bio: user.bio,
      phone: user.phone,
      profileImageUrl: user.profileImageUrl,
      isSuspended: user.isSuspended,
      suspendedReason: user.suspendedReason,
      suspendedAt: user.suspendedAt,
      createdAt: user.createdAt,
      counts: {
        feedPosts: user._count.feedPosts,
        meetupsCreated: user._count.createdMeetups,
        meetupsJoined: user._count.meetupJoins,
        reportsMade: user._count.reportsMade,
        reportsAgainst: reportsAgainstCount,
      },
    },
    recentPosts,
    reportsAgainst: reportsAgainst.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
      reporterUsername: r.reporter.username,
    })),
  });
}

// ------------------------------------------------------------
// 신고 상세보기 - 목록에서는 제목만 보이던 신고 대상을 실제 내용까지 자세히 보여줌
// ------------------------------------------------------------
// GET /api/admin/reports/:id
async function getReportDetail(req, res) {
  const { id } = req.params;

  const report = await prisma.report.findUnique({
    where: { id },
    include: { reporter: { select: { id: true, username: true, name: true } } },
  });
  if (!report) return res.status(404).json({ message: '신고를 찾을 수 없어요.' });

  let target = { exists: false };
  if (report.targetType === 'BUG') {
    target = { exists: true, type: 'BUG' };
  } else if (report.targetType === 'FEED_POST') {
    const post = await prisma.feedPost.findUnique({
      where: { id: report.targetId },
      select: {
        id: true, title: true, note: true, category: true, location: true, rating: true,
        photos: true, createdAt: true,
        author: { select: { id: true, username: true, name: true } },
      },
    });
    if (post) {
      target = {
        exists: true,
        type: 'FEED_POST',
        id: post.id,
        title: post.title,
        note: post.note,
        category: post.category,
        location: post.location,
        rating: post.rating,
        photoCount: (post.photos || []).length,
        createdAt: post.createdAt,
        author: post.author,
      };
    }
  } else if (report.targetType === 'MEETUP') {
    const meetup = await prisma.meetup.findUnique({
      where: { id: report.targetId },
      select: {
        id: true, title: true, description: true, category: true, location: true,
        eventDate: true, cancelled: true, createdAt: true,
        creator: { select: { id: true, username: true, name: true } },
        _count: { select: { participants: true } },
      },
    });
    if (meetup) {
      target = {
        exists: true,
        type: 'MEETUP',
        id: meetup.id,
        title: meetup.title,
        description: meetup.description,
        category: meetup.category,
        location: meetup.location,
        eventDate: meetup.eventDate,
        cancelled: meetup.cancelled,
        createdAt: meetup.createdAt,
        creator: meetup.creator,
        participantCount: meetup._count.participants,
      };
    }
  } else if (report.targetType === 'USER') {
    const user = await prisma.user.findUnique({
      where: { id: report.targetId },
      select: { id: true, username: true, name: true, bio: true, isSuspended: true, createdAt: true },
    });
    if (user) {
      target = { exists: true, type: 'USER', ...user };
    }
  }

  return res.json({
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: report.reason,
    detail: report.detail,
    status: report.status,
    createdAt: report.createdAt,
    reporter: report.reporter,
    target,
  });
}

module.exports = {
  getOverview,
  getDailyStats,
  listUsers, getUserDetail, suspendUser, unsuspendUser, deleteUser,
  listReports, getReportDetail, resolveReport,
  listFeedPosts, getFeedPostDetail, deleteFeedPost,
  listMeetups, cancelMeetup,
  listAdminLogs,
};
