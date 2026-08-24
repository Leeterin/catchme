const prisma = require('../lib/prisma');
const { distanceKm } = require('../lib/geo');
const { getIo } = require('../lib/socket');

// 특정 유저한테 실시간 알림을 보냄 (접속중이 아니면 조용히 무시됨)
function notifyUser(userId, event, payload) {
  const io = getIo();
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

function serializeMeetup(meetup, myUserId) {
  const participants = meetup.participants || [];
  const approved = participants.filter((p) => p.status === 'APPROVED');
  const myParticipant = myUserId ? participants.find((p) => p.userId === myUserId) : null;
  const isCreator = myUserId ? meetup.creatorId === myUserId : false;
  return {
    id: meetup.id,
    title: meetup.title,
    category: meetup.category,
    location: meetup.location,
    lat: meetup.lat,
    lon: meetup.lon,
    dateLabel: meetup.dateLabel,
    timeLabel: meetup.timeLabel,
    eventDate: meetup.eventDate,
    description: meetup.description,
    maxParticipants: meetup.maxParticipants,
    cancelled: meetup.cancelled,
    chatRoomId: meetup.chatRoomId,
    creator: meetup.creator ? { id: meetup.creator.id, username: meetup.creator.username, name: meetup.creator.name } : null,
    isCreator,
    participantCount: approved.length, // 정원은 실제로 승인된 사람만 셈 (신청 대기중인 사람은 아직 자리를 차지하지 않음)
    joined: !!myParticipant && myParticipant.status === 'APPROVED',
    myRequestStatus: myParticipant ? myParticipant.status : null, // 'PENDING' | 'APPROVED' | 'DECLINED' | null(신청한 적 없음)
    pendingRequestCount: isCreator ? participants.filter((p) => p.status === 'PENDING').length : undefined, // 방장한테만 대기중 신청 수 보여줌
    createdAt: meetup.createdAt,
  };
}

// GET /api/meetups?category=food|cafe|experience&lat=&lon=&radiusKm=  (생략하면 전체) - 취소된 모임/이미 지난 모임은 목록에서 제외
async function listMeetups(req, res) {
  const { category } = req.query;
  const meetups = await prisma.meetup.findMany({
    where: {
      cancelled: false,
      OR: [{ eventDate: null }, { eventDate: { gte: new Date() } }], // 날짜를 안 정한 모임은 그대로 두고, 정한 모임은 지났으면 숨김
      ...(category ? { category } : {}),
    },
    include: {
      creator: { select: { id: true, username: true, name: true } },
      participants: { select: { userId: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  let result = meetups.map((m) => serializeMeetup(m, req.userId));

  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    const radiusKm = parseFloat(req.query.radiusKm) || 5;
    // 위치가 없는 모임(장소 좌표를 안 정한 경우)은 반경 필터링 대상에서 제외됨
    result = result
      .filter((m) => typeof m.lat === 'number' && typeof m.lon === 'number')
      .map((m) => ({ ...m, distanceKm: distanceKm(lat, lon, m.lat, m.lon) }))
      .filter((m) => m.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  return res.json({ meetups: result });
}

// POST /api/meetups   body: { title, category, location?, lat?, lon?, dateLabel?, timeLabel?, description?, maxParticipants? }
// 모임을 만들면 그 모임 전용 진짜 그룹 채팅방도 함께 만들어짐 (만든 사람이 첫 멤버)
async function createMeetup(req, res) {
  const { title, category, location, lat, lon, dateLabel, timeLabel, eventDate, description, maxParticipants } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ message: '모임 제목을 입력해주세요.' });
  }
  if (!category || !category.trim()) {
    return res.status(400).json({ message: '카테고리를 선택해주세요.' });
  }
  let parsedEventDate = null;
  if (eventDate) {
    parsedEventDate = new Date(eventDate);
    if (isNaN(parsedEventDate)) return res.status(400).json({ message: '날짜 형식이 올바르지 않아요.' });
    if (parsedEventDate.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ message: '이미 지난 날짜로는 모임을 만들 수 없어요.' });
    }
  }

  const chatRoom = await prisma.chatRoom.create({
    data: {
      isGroup: true,
      name: title.trim(),
      members: { create: [{ userId: req.userId }] },
    },
  });

  const meetup = await prisma.meetup.create({
    data: {
      creatorId: req.userId,
      title: title.trim(),
      category: category.trim(),
      location: location || null,
      lat: typeof lat === 'number' ? lat : null,
      lon: typeof lon === 'number' ? lon : null,
      dateLabel: dateLabel || null,
      timeLabel: timeLabel || null,
      eventDate: parsedEventDate,
      description: description || null,
      maxParticipants: typeof maxParticipants === 'number' && maxParticipants > 0 ? maxParticipants : 6,
      chatRoomId: chatRoom.id,
      participants: { create: [{ userId: req.userId }] }, // 만든 사람은 자동으로 참여
    },
    include: {
      creator: { select: { id: true, username: true, name: true } },
      participants: { select: { userId: true, status: true } },
    },
  });

  return res.status(201).json({ meetup: serializeMeetup(meetup, req.userId) });
}

// PATCH /api/meetups/:id — 만든 사람만 수정 가능. body에 있는 필드만 바꿈
// body: { title?, location?, lat?, lon?, dateLabel?, timeLabel?, description?, maxParticipants? }
async function updateMeetup(req, res) {
  const { id } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id }, include: { participants: true } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.creatorId !== req.userId) {
    return res.status(403).json({ message: '모임을 만든 사람만 수정할 수 있어요.' });
  }
  if (meetup.cancelled) {
    return res.status(409).json({ message: '이미 취소된 모임이에요.' });
  }

  const { title, location, lat, lon, dateLabel, timeLabel, eventDate, description, maxParticipants } = req.body;
  const data = {};
  if (typeof title === 'string' && title.trim()) data.title = title.trim();
  if (typeof location === 'string') data.location = location || null;
  if (typeof lat === 'number') data.lat = lat;
  if (typeof lon === 'number') data.lon = lon;
  if (typeof dateLabel === 'string') data.dateLabel = dateLabel || null;
  if (typeof timeLabel === 'string') data.timeLabel = timeLabel || null;
  if (eventDate) {
    const parsed = new Date(eventDate);
    if (isNaN(parsed)) return res.status(400).json({ message: '날짜 형식이 올바르지 않아요.' });
    if (parsed.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ message: '이미 지난 날짜로는 바꿀 수 없어요.' });
    }
    data.eventDate = parsed;
  }
  if (typeof description === 'string') data.description = description || null;
  if (typeof maxParticipants === 'number' && maxParticipants > 0) {
    const approvedCount = meetup.participants.filter((p) => p.status === 'APPROVED').length;
    if (maxParticipants < approvedCount) {
      return res.status(400).json({ message: `이미 ${approvedCount}명이 참여 중이라, 정원을 그보다 적게 줄일 수 없어요.` });
    }
    data.maxParticipants = maxParticipants;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }

  // 제목이 바뀌면 모임 전용 채팅방 이름도 같이 맞춰줌
  if (data.title && meetup.chatRoomId) {
    await prisma.chatRoom.update({ where: { id: meetup.chatRoomId }, data: { name: data.title } });
  }

  const updated = await prisma.meetup.update({
    where: { id },
    data,
    include: {
      creator: { select: { id: true, username: true, name: true } },
      participants: { select: { userId: true, status: true } },
    },
  });
  return res.json({ meetup: serializeMeetup(updated, req.userId) });
}

// POST /api/meetups/:id/cancel — 만든 사람만 취소 가능. 모임 자체는 지우지 않고 목록에서만 감추고,
// 기존 채팅방/대화는 그대로 남겨서 이미 참여한 사람들끼리는 계속 얘기할 수 있게 함
async function cancelMeetup(req, res) {
  const { id } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.creatorId !== req.userId) {
    return res.status(403).json({ message: '모임을 만든 사람만 취소할 수 있어요.' });
  }
  if (meetup.cancelled) {
    return res.status(409).json({ message: '이미 취소된 모임이에요.' });
  }

  const updated = await prisma.meetup.update({
    where: { id },
    data: { cancelled: true },
    include: {
      creator: { select: { id: true, username: true, name: true } },
      participants: { select: { userId: true, status: true } },
    },
  });

  // 채팅방에 취소 안내 메시지를 남겨서, 참여자들이 대화창에서 바로 알 수 있게 함
  if (meetup.chatRoomId) {
    await prisma.message.create({
      data: { chatRoomId: meetup.chatRoomId, senderId: req.userId, type: 'TEXT', text: `"${meetup.title}" 모임이 취소됐어요.` },
    });
  }

  return res.json({ meetup: serializeMeetup(updated, req.userId) });
}

// POST /api/meetups/:id/join — 참여하면 모임 채팅방 멤버로도 함께 들어감
// POST /api/meetups/:id/join — 바로 들어가지 않고 "참여 신청"을 넣음. 방장이 수락해야 정식 참여+채팅방 입장이 됨
async function joinMeetup(req, res) {
  const { id } = req.params;
  const { intro } = req.body;
  const meetup = await prisma.meetup.findUnique({ where: { id }, include: { participants: true } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.cancelled) return res.status(409).json({ message: '취소된 모임이에요.' });
  if (meetup.creatorId === req.userId) return res.status(400).json({ message: '내가 만든 모임이에요.' });

  const existing = meetup.participants.find((p) => p.userId === req.userId);
  if (existing) {
    if (existing.status === 'PENDING') return res.status(400).json({ message: '이미 참여 신청을 보낸 상태예요. 방장의 수락을 기다려주세요.' });
    if (existing.status === 'APPROVED') return res.status(400).json({ message: '이미 참여 중인 모임이에요.' });
    // DECLINED였던 경우 - 다시 신청할 수 있게 허용함 (아래에서 PENDING으로 되돌림)
  }

  const approvedCount = meetup.participants.filter((p) => p.status === 'APPROVED').length;
  if (approvedCount >= meetup.maxParticipants) {
    return res.status(400).json({ message: '정원이 다 찼어요.' });
  }

  try {
    if (existing) {
      await prisma.meetupParticipant.update({ where: { id: existing.id }, data: { status: 'PENDING', intro: intro || null } });
    } else {
      await prisma.meetupParticipant.create({ data: { meetupId: id, userId: req.userId, status: 'PENDING', intro: intro || null } });
    }
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ message: '이미 신청했거나 참여 중인 모임이에요.' });
    }
    throw err;
  }

  notifyUser(meetup.creatorId, 'meetupJoinRequest', { meetupId: id, meetupTitle: meetup.title });

  return res.json({ message: '참여 신청을 보냈어요. 방장이 수락하면 채팅방에 들어갈 수 있어요.' });
}

// GET /api/meetups/:id/requests — 방장이 대기중인 참여 신청 목록을 확인
async function listJoinRequests(req, res) {
  const { id } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.creatorId !== req.userId) return res.status(403).json({ message: '방장만 볼 수 있어요.' });

  const pending = await prisma.meetupParticipant.findMany({
    where: { meetupId: id, status: 'PENDING' },
    include: { user: { select: { id: true, username: true, name: true, profileImageUrl: true } } },
    orderBy: { joinedAt: 'asc' },
  });

  return res.json({
    requests: pending.map((p) => ({
      userId: p.user.id,
      username: p.user.username,
      name: p.user.name,
      hasAvatar: !!p.user.profileImageUrl,
      intro: p.intro || null,
      requestedAt: p.joinedAt,
    })),
  });
}

// 참여 신청을 수락/거절 처리하는 공용 로직
async function respondToJoinRequest(req, res, approve) {
  const { id, userId } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id }, include: { participants: true } });
  if (!meetup) return res.status(404).json({ message: '모임을 찾을 수 없어요.' });
  if (meetup.creatorId !== req.userId) return res.status(403).json({ message: '방장만 처리할 수 있어요.' });

  const participant = meetup.participants.find((p) => p.userId === userId && p.status === 'PENDING');
  if (!participant) return res.status(404).json({ message: '대기중인 신청을 찾을 수 없어요.' });

  if (approve) {
    const approvedCount = meetup.participants.filter((p) => p.status === 'APPROVED').length;
    if (approvedCount >= meetup.maxParticipants) {
      return res.status(400).json({ message: '정원이 다 찼어요.' });
    }
    await prisma.$transaction(async (tx) => {
      await tx.meetupParticipant.update({ where: { id: participant.id }, data: { status: 'APPROVED' } });
      if (meetup.chatRoomId) {
        await tx.chatRoomMember.upsert({
          where: { chatRoomId_userId: { chatRoomId: meetup.chatRoomId, userId } },
          update: {},
          create: { chatRoomId: meetup.chatRoomId, userId },
        });
      }
    });
    notifyUser(userId, 'meetupJoinApproved', { meetupId: id, meetupTitle: meetup.title, chatRoomId: meetup.chatRoomId });
    return res.json({ message: '참여를 수락했어요.' });
  }

  await prisma.meetupParticipant.update({ where: { id: participant.id }, data: { status: 'DECLINED' } });
  notifyUser(userId, 'meetupJoinDeclined', { meetupId: id, meetupTitle: meetup.title });
  return res.json({ message: '참여 신청을 거절했어요.' });
}
const approveJoinRequest = (req, res) => respondToJoinRequest(req, res, true);
const declineJoinRequest = (req, res) => respondToJoinRequest(req, res, false);

// POST /api/meetups/:id/leave — 나가면 모임 채팅방에서도 함께 나가짐
async function leaveMeetup(req, res) {
  const { id } = req.params;
  const meetup = await prisma.meetup.findUnique({ where: { id } });
  await prisma.meetupParticipant.deleteMany({ where: { meetupId: id, userId: req.userId } });
  if (meetup && meetup.chatRoomId) {
    await prisma.chatRoomMember.deleteMany({ where: { chatRoomId: meetup.chatRoomId, userId: req.userId } });
  }
  return res.json({ message: '모임에서 나갔어요.' });
}

// GET /api/meetups/suggested-friends?lat=&lon=&radiusKm=
// 위치가 주어지면: 그 반경 안에서 위치를 공유해둔(아이디 검색 허용한) 사람들을 거리순으로 추천 (동네 기반 발견).
// 위치가 없으면: 예전 방식대로 "내 친구의 친구"인데 아직 나랑 친구도 아니고 대기중인 요청도 없는 사람들을 추천.
async function suggestedFriends(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  // 이미 친구거나 요청을 주고받은 사이(대기중 포함)는 추천에서 제외 - 두 모드 공통
  // (거절된 요청까지 여기 포함시키면 한 번 거절한 사람이 영영 추천에 안 뜨게 되므로, PENDING/ACCEPTED만 제외 대상으로 삼음)
  const existingRequests = await prisma.friendRequest.findMany({
    where: {
      OR: [{ senderId: req.userId }, { receiverId: req.userId }],
      status: { in: ['PENDING', 'ACCEPTED'] },
    },
  });
  const excluded = new Set(
    existingRequests.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId))
  );

  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    const radiusKm = parseFloat(req.query.radiusKm) || 5;
    const nearbyUsers = await prisma.user.findMany({
      where: {
        id: { notIn: [req.userId, ...excluded] },
        lastLat: { not: null },
        lastLon: { not: null },
        OR: [{ settings: null }, { settings: { friendSearchAllow: true } }],
      },
      select: { id: true, username: true, name: true, profileImageUrl: true, lastLat: true, lastLon: true },
    });

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: req.userId }, { blockedId: req.userId }] },
    });
    const blockedIds = new Set();
    blocks.forEach((b) => blockedIds.add(b.blockerId === req.userId ? b.blockedId : b.blockerId));

    const suggestions = nearbyUsers
      .filter((u) => !blockedIds.has(u.id))
      .map((u) => ({
        id: u.id, username: u.username, name: u.name, hasAvatar: !!u.profileImageUrl,
        distanceKm: distanceKm(lat, lon, u.lastLat, u.lastLon),
      }))
      .filter((u) => u.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 20);

    return res.json({ suggestions });
  }

  const myAccepted = await prisma.friendRequest.findMany({
    where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
  });
  const myFriendIds = new Set(
    myAccepted.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId))
  );

  if (myFriendIds.size === 0) {
    return res.json({ suggestions: [] });
  }

  const friendsOfFriends = await prisma.friendRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: { in: [...myFriendIds] } },
        { receiverId: { in: [...myFriendIds] } },
      ],
    },
  });

  const mutualCount = {};
  friendsOfFriends.forEach((r) => {
    [r.senderId, r.receiverId].forEach((uid) => {
      if (uid === req.userId || myFriendIds.has(uid)) return;
      mutualCount[uid] = (mutualCount[uid] || 0) + 1;
    });
  });

  const candidateIds = Object.keys(mutualCount)
    .filter((uid) => !excluded.has(uid))
    .sort((a, b) => mutualCount[b] - mutualCount[a])
    .slice(0, 10);

  if (candidateIds.length === 0) {
    return res.json({ suggestions: [] });
  }

  const users = await prisma.user.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, username: true, name: true, profileImageUrl: true },
  });
  const suggestions = candidateIds
    .map((id) => users.find((u) => u.id === id))
    .filter(Boolean)
    .map((u) => ({ id: u.id, username: u.username, name: u.name, hasAvatar: !!u.profileImageUrl, mutualFriendCount: mutualCount[u.id] }));

  return res.json({ suggestions });
}

module.exports = {
  listMeetups, createMeetup, updateMeetup, cancelMeetup,
  joinMeetup, leaveMeetup, listJoinRequests, approveJoinRequest, declineJoinRequest,
  suggestedFriends,
};
