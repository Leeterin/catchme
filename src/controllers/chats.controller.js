const prisma = require('../lib/prisma');
const { getIo } = require('../lib/socket');

const MEMBER_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  profileImageUrl: true,
};

// 이 채팅방에서 나를 제외한 나머지 멤버 id 목록 (실시간 알림을 보낼 대상)
async function getOtherMemberIds(chatRoomId, userId) {
  const members = await prisma.chatRoomMember.findMany({
    where: { chatRoomId },
    select: { userId: true },
  });
  return members.map((m) => m.userId).filter((id) => id !== userId);
}

// 이 채팅방의 나머지 멤버들에게 실시간으로 이벤트를 보냄 (연결 안 돼있으면 그냥 무시됨)
async function notifyRoom(chatRoomId, senderId, event, payload) {
  const io = getIo();
  if (!io) return;
  const otherIds = await getOtherMemberIds(chatRoomId, senderId);
  otherIds.forEach((userId) => {
    io.to(`user:${userId}`).emit(event, payload);
  });
}

function serializeMessage(message) {
  const base = {
    id: message.id,
    senderId: message.senderId,
    type: message.type,
    createdAt: message.createdAt,
  };

  if (message.type === 'TEXT') {
    return { ...base, text: message.text };
  }

  if (message.type === 'TIME_PROPOSAL') {
    return {
      ...base,
      proposal: {
        status: message.proposalStatus,
        options: (message.proposalOptions || []).map((opt) => ({
          id: opt.id,
          start: opt.startTime,
          end: opt.endTime,
          voterIds: (opt.votes || []).map((v) => v.userId),
        })),
      },
    };
  }

  if (message.type === 'IMAGE') {
    return { ...base, imageUrl: message.imageUrl };
  }

  if (message.type === 'LOCATION_SUGGEST') {
    return {
      ...base,
      locationSuggestion: {
        place: message.locationPlace,
        note: message.locationNote,
        location: message.locationAddress,
        locationLat: message.locationLat,
        locationLon: message.locationLon,
        status: message.locationStatus,
      },
    };
  }

  return {
    ...base,
    reservation: {
      start: message.reservationStart,
      end: message.reservationEnd,
      note: message.reservationNote,
      location: message.reservationLocation,
      locationLat: message.reservationLocationLat,
      locationLon: message.reservationLocationLon,
      status: message.reservationStatus,
    },
  };
}

// TIME_PROPOSAL 메시지를 조회할 때 항상 같이 불러와야 하는 관계
const PROPOSAL_INCLUDE = { proposalOptions: { include: { votes: true } } };

// 일정이 확정(예약 수락/그룹투표 확정)되면, 그 시간과 겹치는 "예약 가능"(AVAILABLE) 표시는 이제 다 찬 거니까 정리해줌.
// 겹치는 부분만 없애고, 앞뒤로 남는 시간이 있으면 그 부분은 그대로 "예약 가능"으로 다시 남겨둠 (통째로 지우면 관계없는 시간까지 예약 불가 처리되니까)
async function clearAvailabilityInRange(userIds, start, end, client) {
  const db = client || prisma;
  const overlapping = await db.event.findMany({
    where: {
      userId: { in: userIds },
      status: 'AVAILABLE',
      startTime: { lt: end },
      endTime: { gt: start },
    },
  });
  for (const ev of overlapping) {
    await db.event.delete({ where: { id: ev.id } });
    if (ev.startTime < start) {
      await db.event.create({
        data: {
          userId: ev.userId, status: 'AVAILABLE', eventType: 'available', title: ev.title,
          startTime: ev.startTime, endTime: start,
          visibleGroupIds: ev.visibleGroupIds, visiblePrivate: ev.visiblePrivate,
        },
      });
    }
    if (ev.endTime > end) {
      await db.event.create({
        data: {
          userId: ev.userId, status: 'AVAILABLE', eventType: 'available', title: ev.title,
          startTime: end, endTime: ev.endTime,
          visibleGroupIds: ev.visibleGroupIds, visiblePrivate: ev.visiblePrivate,
        },
      });
    }
  }
}

// clearAvailabilityInRange의 반대 동작. 예약 요청이 거절/철회/취소돼서 그 구간이 다시 비게 됐을 때,
// 바로 양옆에 붙어있는 "예약 가능" 조각이 있으면 그것들과 하나로 다시 합쳐서 원래 모양(예: 2-9시)으로 되돌림.
// 옆에 아무것도 없으면 이 구간만큼만 새로 "예약 가능"으로 만듦.
// 취소/거절/철회된 예약 시간을 "예약 가능"으로 되돌림.
// 단, 그 시간 안에 이미 다른 바쁨 일정(예: 운동 등, 예약과 무관하게 원래 있던 일정)이 남아있으면
// 그 부분까지 예약 가능으로 되살리면 안 되므로, 실제로 비어있는 부분만 골라서 되살림
// (예: 9-10시가 원래 운동이었는데 9-10시로 예약을 걸었다가 취소되면, 9-10시는 그대로 운동으로 남고
// 예약 가능은 새로 생기지 않아야 함 - 원래 그 시간엔 예약 가능이 아니었으니까)
async function restoreAvailabilityInRange(userId, start, end, client) {
  const db = client || prisma;

  // 이 범위와 겹치는, 아직 남아있는 다른 바쁨 일정들을 찾음 (지금 취소되는 이 예약 자신의 홀드는
  // 이 함수가 불리기 전에 이미 삭제된 상태이므로 여기엔 안 걸림)
  const busyOverlaps = await db.event.findMany({
    where: { userId, status: 'BUSY', startTime: { lt: end }, endTime: { gt: start } },
    orderBy: { startTime: 'asc' },
  });

  // [start, end) 구간에서 바쁨 일정과 안 겹치는 조각들만 추려냄
  const freeSegments = [];
  let cursor = start;
  busyOverlaps.forEach((busy) => {
    const busyStart = busy.startTime < start ? start : busy.startTime;
    const busyEnd = busy.endTime > end ? end : busy.endTime;
    if (busyStart > cursor) freeSegments.push({ start: cursor, end: busyStart });
    if (busyEnd > cursor) cursor = busyEnd;
  });
  if (cursor < end) freeSegments.push({ start: cursor, end });

  for (const seg of freeSegments) {
    const left = await db.event.findFirst({
      where: { userId, status: 'AVAILABLE', endTime: seg.start },
    });
    const right = await db.event.findFirst({
      where: { userId, status: 'AVAILABLE', startTime: seg.end },
    });

    let mergedStart = seg.start, mergedEnd = seg.end;
    let title = '예약 가능', visibleGroupIds = [], visiblePrivate = false;
    if (left) {
      mergedStart = left.startTime;
      title = left.title;
      visibleGroupIds = left.visibleGroupIds;
      visiblePrivate = left.visiblePrivate;
    }
    if (right) {
      mergedEnd = right.endTime;
      title = right.title;
      visibleGroupIds = right.visibleGroupIds;
      visiblePrivate = right.visiblePrivate;
    }
    if (left) await db.event.delete({ where: { id: left.id } });
    if (right) await db.event.delete({ where: { id: right.id } });

    await db.event.create({
      data: {
        userId, status: 'AVAILABLE', eventType: 'available', title,
        startTime: mergedStart, endTime: mergedEnd,
        visibleGroupIds, visiblePrivate,
      },
    });
  }
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 이름 마지막 글자에 받침이 있는지 보고 "와"/"과" 중 맞는 조사를 고름 (예: "민수"->와, "지훈"->과)
function withWaGwa(name) {
  if (!name) return `상대방과`;
  const lastChar = name[name.length - 1];
  const code = lastChar.charCodeAt(0) - 0xAC00;
  const hasBatchim = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${name}${hasBatchim ? '과' : '와'}`;
}
// UTC 타임스탬프를 서버 시간대 설정과 무관하게 항상 한국 시간(KST) 기준으로 분해함
function toKstParts(date) {
  const d = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay(),
  };
}
function formatDateLabel(date) {
  const p = toKstParts(date);
  return `${p.month}/${p.day}(${WEEKDAY_KO[p.weekday]})`;
}
function formatTimeLabel(start, end) {
  const s = toKstParts(start);
  const e = toKstParts(end);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(s.hour)}:${pad(s.minute)}-${pad(e.hour)}:${pad(e.minute)}`;
}

async function assertMembership(chatRoomId, userId) {
  const membership = await prisma.chatRoomMember.findUnique({
    where: { chatRoomId_userId: { chatRoomId, userId } },
  });
  return !!membership;
}

// 메시지를 "새로 보낼" 수 있는지 확인 (멤버인지 + 1:1 방이면 서로 차단 상태가 아닌지).
// 차단해도 예전 대화 내용은 그대로 보여야 하니, 이 체크는 조회가 아니라 "새로 보내는" 액션에서만 씀.
async function assertCanMessage(chatRoomId, userId) {
  const room = await prisma.chatRoom.findUnique({
    where: { id: chatRoomId },
    include: { members: true },
  });
  if (!room || !room.members.some((m) => m.userId === userId)) {
    return { ok: false, statusCode: 403, message: '이 채팅방에 접근할 권한이 없어요.' };
  }
  if (!room.isGroup) {
    const other = room.members.find((m) => m.userId !== userId);
    if (other) {
      const blocked = await prisma.block.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedId: other.userId },
            { blockerId: other.userId, blockedId: userId },
          ],
        },
      });
      if (blocked) {
        return { ok: false, statusCode: 403, message: '차단된 사용자와는 메시지를 주고받을 수 없어요.' };
      }
    }
  }
  return { ok: true };
}

// GET /api/chats — 내가 속한 채팅방 목록, 최근 활동 순 정렬
async function listChatRooms(req, res) {
  const memberships = await prisma.chatRoomMember.findMany({
    where: { userId: req.userId },
    include: {
      chatRoom: {
        include: {
          members: { include: { user: { select: MEMBER_USER_SELECT } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });

  // 각 방마다 "내가 마지막으로 읽은 시각 이후, 내가 보낸 게 아닌 메시지" 개수를 세서 안읽음 배지에 사용
  const rooms = await Promise.all(
    memberships.map(async (membership) => {
      const room = membership.chatRoom;
      const otherMember = room.isGroup ? null : room.members.find((mem) => mem.userId !== req.userId);
      // 사진 원본(base64) 대신 있는지 여부만 - 실제 이미지는 캐싱되는 /api/users/:id/avatar 로 따로 받음
      const other = otherMember ? { ...otherMember.user, hasAvatar: !!otherMember.user.profileImageUrl, profileImageUrl: undefined } : null;
      const otherLastReadAt = otherMember ? otherMember.lastReadAt : null; // 상대방이 언제까지 읽었는지 - 보낸 메시지의 "읽음" 표시에 씀
      const lastMessage = room.messages[0] || null;

      const unreadCount = await prisma.message.count({
        where: {
          chatRoomId: room.id,
          createdAt: { gt: membership.lastReadAt },
          senderId: { not: req.userId },
        },
      });

      return {
        id: room.id,
        isGroup: room.isGroup,
        name: room.isGroup ? room.name : other?.name,
        counterpart: other || null,
        members: room.isGroup
          ? room.members.map((mem) => ({
              userId: mem.userId,
              username: mem.user.username,
              name: mem.userId === req.userId ? '나' : mem.user.name,
              hasAvatar: !!mem.user.profileImageUrl,
            }))
          : null,
        unreadCount,
        muted: membership.muted,
        otherLastReadAt,
        lastMessage: lastMessage ? serializeMessage(lastMessage) : null,
        lastActivityAt: lastMessage ? lastMessage.createdAt : room.createdAt,
      };
    })
  );

  rooms.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

  return res.json({ rooms });
}

// POST /api/chats/:roomId/read — 이 방을 지금 읽었다고 표시 (안읽음 개수 0으로)
async function markRoomRead(req, res) {
  const { roomId } = req.params;
  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  const readAt = new Date();
  await prisma.chatRoomMember.update({
    where: { chatRoomId_userId: { chatRoomId: roomId, userId: req.userId } },
    data: { lastReadAt: readAt },
  });
  // 방의 다른 멤버들한테 "이 사람이 여기까지 읽었어요"를 실시간으로 알려줘서, 보낸 메시지 옆 "읽음" 표시가 바로 바뀌게 함
  await notifyRoom(roomId, req.userId, 'roomRead', { roomId, userId: req.userId, lastReadAt: readAt });
  return res.json({ ok: true });
}

// POST /api/chats/:roomId/mute   body: { muted: boolean } — 나한테만 적용됨(다른 멤버 알림엔 영향 없음), 안읽음 표시는 그대로 유지됨
async function setRoomMuted(req, res) {
  const { roomId } = req.params;
  const { muted } = req.body;
  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  await prisma.chatRoomMember.update({
    where: { chatRoomId_userId: { chatRoomId: roomId, userId: req.userId } },
    data: { muted: !!muted },
  });
  return res.json({ muted: !!muted });
}

// POST /api/chats/direct   body: { username }
// 상대방과의 1:1 채팅방을 가져오거나, 없으면 새로 만든다.
async function getOrCreateDirectRoom(req, res) {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: '상대방 아이디를 입력해주세요.' });

  const other = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!other) return res.status(404).json({ message: '해당 아이디의 유저를 찾을 수 없어요.' });
  if (other.id === req.userId) {
    return res.status(400).json({ message: '자기 자신과는 채팅방을 만들 수 없어요.' });
  }
  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: req.userId, blockedId: other.id },
        { blockerId: other.id, blockedId: req.userId },
      ],
    },
  });
  if (blocked) {
    return res.status(403).json({ message: '차단된 사용자와는 채팅방을 열 수 없어요.' });
  }

  // 이미 존재하는 1:1 방이 있는지 찾기 (상대방이 멤버로 있는 비그룹 방 - 내가 예전에 "나가기"를 눌렀었어도
  // 방 자체는 남아있으니 다시 찾아서 재입장시킴. 안 그러면 나갈 때마다 상대방 쪽에 방이 중복으로 쌓임)
  // ⚠️ 반드시 "나(req.userId)도 원래 이 방에 있었던 적이 있는지"까지 같이 확인해야 함 - 상대방이 멤버라는
  // 조건만으로 찾으면, 나와 전혀 상관없는 그 사람의 다른 1:1 방(그 방에서 다른 사람이 나간 자리)을
  // 잘못 찾아서 내가 그 방에 들어가버리고, 그 방에 남아있던 예전 대화 내역을 그대로 볼 수 있게 됨.
  const existing = await prisma.chatRoom.findFirst({
    where: {
      isGroup: false,
      members: { some: { userId: other.id } },
      OR: [
        { members: { some: { userId: req.userId } } },
        { messages: { some: { senderId: req.userId } } },
      ],
    },
    include: { members: true },
  });

  if (existing) {
    const alreadyMember = existing.members.some((m) => m.userId === req.userId);
    if (!alreadyMember) {
      await prisma.chatRoomMember.create({ data: { chatRoomId: existing.id, userId: req.userId } });
    }
    return res.json({ roomId: existing.id, created: false });
  }

  const room = await prisma.chatRoom.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: req.userId }, { userId: other.id }] },
    },
  });

  return res.status(201).json({ roomId: room.id, created: true });
}

// GET /api/chats/:roomId/messages?cursor=&limit=
async function listMessages(req, res) {
  const { roomId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }

  const messages = await prisma.message.findMany({
    where: { chatRoomId: roomId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: PROPOSAL_INCLUDE,
    ...(req.query.cursor ? { skip: 1, cursor: { id: req.query.cursor } } : {}),
  });

  return res.json({ messages: messages.reverse().map(serializeMessage) });
}

// POST /api/chats/:roomId/messages   body: { text }
async function sendTextMessage(req, res) {
  const { roomId } = req.params;
  const { text } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ message: '메시지 내용을 입력해주세요.' });
  const canMessage = await assertCanMessage(roomId, req.userId);
  if (!canMessage.ok) {
    return res.status(canMessage.statusCode).json({ message: canMessage.message });
  }

  const message = await prisma.message.create({
    data: { chatRoomId: roomId, senderId: req.userId, type: 'TEXT', text: text.trim() },
  });

  await notifyRoom(roomId, req.userId, 'newMessage', { roomId, message: serializeMessage(message) });

  return res.status(201).json({ message: serializeMessage(message) });
}

// 채팅 사진은 최대 700000자(base64 기준 약 500KB)까지만 - 프로필 사진과 동일한 제한
const MAX_CHAT_IMAGE_CHARS = 700000;

// POST /api/chats/:roomId/images   body: { imageUrl } (data:image/... base64)
async function sendImageMessage(req, res) {
  const { roomId } = req.params;
  const { imageUrl } = req.body;

  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('data:image/')) {
    return res.status(400).json({ message: '이미지 형식이 올바르지 않아요.' });
  }
  if (imageUrl.length > MAX_CHAT_IMAGE_CHARS) {
    return res.status(400).json({ message: '이미지 용량이 너무 커요. 더 작은 사진을 사용해주세요.' });
  }
  const canMessage = await assertCanMessage(roomId, req.userId);
  if (!canMessage.ok) {
    return res.status(canMessage.statusCode).json({ message: canMessage.message });
  }

  const message = await prisma.message.create({
    data: { chatRoomId: roomId, senderId: req.userId, type: 'IMAGE', imageUrl },
  });

  await notifyRoom(roomId, req.userId, 'newMessage', { roomId, message: serializeMessage(message) });
  return res.status(201).json({ message: serializeMessage(message) });
}

// POST /api/chats/:roomId/reservations   body: { start, end, note }
// 이 사람(receiverId)이 "받는 입장"으로 이미 걸려있는 다른 대기중인 예약 요청과 시간이 겹치는지 확인 (더블부킹 방지)
async function hasConflictingPendingRequest(receiverId, start, end) {
  const pending = await prisma.message.findFirst({
    where: {
      type: 'RESERVATION',
      reservationStatus: 'PENDING',
      senderId: { not: receiverId }, // receiverId 본인이 보낸 요청은 상관없음 - "받는" 입장인 것만 체크
      reservationStart: { lt: end },
      reservationEnd: { gt: start },
      chatRoom: { members: { some: { userId: receiverId } } },
    },
  });
  return !!pending;
}

async function sendReservationRequest(req, res) {
  const { roomId } = req.params;
  const { start, end, note, location, locationLat, locationLon } = req.body;

  if (!start || !end) return res.status(400).json({ message: '시작/종료 시간을 입력해주세요.' });
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate) || isNaN(endDate) || endDate <= startDate) {
    return res.status(400).json({ message: '시간 범위가 올바르지 않아요.' });
  }
  const canMessage = await assertCanMessage(roomId, req.userId);
  if (!canMessage.ok) {
    return res.status(canMessage.statusCode).json({ message: canMessage.message });
  }

  // 이 방의 상대방(받는 사람)을 찾아서, 그 사람이 이미 같은 시간에 다른 사람의 요청을 받아둔 상태인지 확인 (더블부킹 방지)
  const otherMemberIds = await getOtherMemberIds(roomId, req.userId);
  for (const receiverId of otherMemberIds) {
    if (await hasConflictingPendingRequest(receiverId, startDate, endDate)) {
      return res.status(409).json({ message: '이미 다른 사람이 같은 시간에 요청을 보내둔 상태예요. 잠시 후 다시 시도해주세요.' });
    }
  }

  // 내 캘린더에 만들 "예약중..." 홀드 제목에 상대방 이름을 넣기 위해 조회 (1:1 방 기준 - 그룹이면 그냥 "예약중..."으로 둠)
  let holdTitle = '예약중...';
  if (otherMemberIds.length === 1) {
    const receiver = await prisma.user.findUnique({ where: { id: otherMemberIds[0] }, select: { name: true } });
    if (receiver && receiver.name) holdTitle = `${receiver.name}님에게 예약 요청중`;
  }

  const message = await prisma.$transaction(async (tx) => {
    const createdMessage = await tx.message.create({
      data: {
        chatRoomId: roomId,
        senderId: req.userId,
        type: 'RESERVATION',
        reservationStart: startDate,
        reservationEnd: endDate,
        reservationNote: note || null,
        reservationLocation: location || null,
        reservationLocationLat: typeof locationLat === 'number' ? locationLat : null,
        reservationLocationLon: typeof locationLon === 'number' ? locationLon : null,
        reservationStatus: 'PENDING',
      },
    });

    // 내가 요청하는 이 시간과 겹치는 내 "예약 가능" 표시가 있으면, 겹치는 부분만 잘라내고
    // (남는 앞뒤 시간은 그대로 예약 가능으로 유지) "예약중..." 홀드를 새로 만듦
    await clearAvailabilityInRange([req.userId], startDate, endDate, tx);

    // 보낸 사람 본인 캘린더에 "예약중..." 홀드를 만들어서, 상대가 응답하기 전까지 그 시간이 비어있는 것처럼 보이지 않게 함
    await tx.event.create({
      data: {
        userId: req.userId,
        startTime: startDate,
        endTime: endDate,
        title: holdTitle,
        status: 'BUSY',
        isPendingHold: true,
        sourceMessageId: createdMessage.id,
        sourceChatRoomId: roomId,
      },
    });

    return createdMessage;
  });

  await notifyRoom(roomId, req.userId, 'newMessage', { roomId, message: serializeMessage(message) });

  return res.status(201).json({ message: serializeMessage(message) });
}

// POST /api/chats/messages/:messageId/accept
// 받는 사람(보낸 사람이 아닌 멤버)만 수락할 수 있고, 수락하면 두 사람 모두의
// 캘린더(Event)에 BUSY 일정으로 등록된다.
async function respondToReservation(req, res, status) {
  const { messageId } = req.params;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { chatRoom: { include: { members: { include: { user: { select: { name: true } } } } } } },
  });
  if (!message || message.type !== 'RESERVATION') {
    return res.status(404).json({ message: '예약 요청을 찾을 수 없어요.' });
  }

  const isMember = message.chatRoom.members.some((m) => m.userId === req.userId);
  if (!isMember) return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  if (message.senderId === req.userId) {
    return res.status(403).json({ message: '본인이 보낸 요청은 직접 수락/거절할 수 없어요.' });
  }
  if (message.reservationStatus !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 요청이에요.' });
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // 상태가 여전히 PENDING일 때만 업데이트되도록 조건을 걸어서, 거의 동시에 두 번 요청이 와도
      // 딱 하나만 실제로 처리되게 함 (둘 다 PENDING을 보고 동시에 통과해버리는 경쟁 상태 방지)
      const { count } = await tx.message.updateMany({
        where: { id: messageId, reservationStatus: 'PENDING' },
        data: { reservationStatus: status },
      });
      if (count === 0) {
        throw Object.assign(new Error('이미 처리된 요청이에요.'), { statusCode: 409 });
      }

    // 보낸 사람 쪽에 만들어뒀던 "예약중..." 홀드는 이제 용도가 끝났으니 지움
    // (확정이면 바로 아래에서 정식 약속 일정을 새로 만들고, 거절이면 그냥 지운 채로 끝)
    await tx.event.deleteMany({ where: { sourceMessageId: message.id, isPendingHold: true } });

    if (status === 'DECLINED') {
      // 거절됐으니, 보낸 사람 쪽에서 잘라냈던 "예약 가능" 시간을 원래대로 복원함
      await restoreAvailabilityInRange(message.senderId, message.reservationStart, message.reservationEnd, tx);
    }

    if (status === 'CONFIRMED') {
      const members = message.chatRoom.members;
      const memberIds = members.map((m) => m.userId);

      // 확정된 시간과 겹치는 "예약 가능" 표시를 정리 (안 그러면 같은 시간에 "예약 가능"이랑 "약속"이 같이 남아서 헷갈림)
      await clearAvailabilityInRange(memberIds, message.reservationStart, message.reservationEnd, tx);

      // 각자 캘린더에는 "상대방 이름과 약속"으로(메모가 있으면 뒤에 덧붙여서) 남도록 사람마다 다르게 제목을 만듦
      await tx.event.createMany({
        data: members.map((m) => {
          const other = members.find((x) => x.userId !== m.userId);
          const baseTitle = other ? `${withWaGwa(other.user.name)} 약속` : '약속';
          const title = message.reservationNote ? `${baseTitle} - ${message.reservationNote}` : baseTitle;
          return {
            userId: m.userId,
            startTime: message.reservationStart,
            endTime: message.reservationEnd,
            title,
            status: 'BUSY',
            // 확정된 약속은 기본적으로 "나만보기"로 등록되고, 이후 캘린더에서 직접 바꿀 수 있음
            visibleGroupIds: [],
            visiblePrivate: true,
            sourceMessageId: message.id,
            sourceChatRoomId: message.chatRoomId,
          };
        }),
      });

      // 확정된 예약을 채팅방에 핀으로도 고정
      const dateLabel = formatDateLabel(message.reservationStart);
      const timeLabel = formatTimeLabel(message.reservationStart, message.reservationEnd);
      await tx.pinnedItem.create({
        data: {
          chatRoomId: message.chatRoomId,
          dateLabel,
          timeLabel,
          note: message.reservationNote,
          location: message.reservationLocation,
          sourceMessageId: message.id,
        },
      });
    }

    return tx.message.findUnique({ where: { id: messageId } });
  });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    throw err;
  }

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });

  return res.json({ message: serializeMessage(updated) });
}

// POST /api/chats/messages/:messageId/withdraw — 보낸 사람이 대기중인 요청을 스스로 취소
async function withdrawReservation(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.type !== 'RESERVATION') {
    return res.status(404).json({ message: '예약 요청을 찾을 수 없어요.' });
  }
  if (message.senderId !== req.userId) {
    return res.status(403).json({ message: '본인이 보낸 요청만 취소할 수 있어요.' });
  }
  if (message.reservationStatus !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 요청이에요.' });
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.message.updateMany({
        where: { id: messageId, reservationStatus: 'PENDING' },
        data: { reservationStatus: 'WITHDRAWN' },
      });
      if (count === 0) {
        throw Object.assign(new Error('이미 처리된 요청이에요.'), { statusCode: 409 });
      }
      // 스스로 철회했으니, 만들어뒀던 "예약중..." 홀드도 같이 지우고, 잘라냈던 "예약 가능" 시간을 원래대로 복원함
      await tx.event.deleteMany({ where: { sourceMessageId: message.id, isPendingHold: true } });
      await restoreAvailabilityInRange(message.senderId, message.reservationStart, message.reservationEnd, tx);
      return tx.message.findUnique({ where: { id: messageId } });
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    throw err;
  }
  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// POST /api/chats/messages/:messageId/cancel — 확정됐던 예약을 취소 (핀도 함께 제거)
async function cancelReservationMessage(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { chatRoom: { include: { members: true } } } });
  if (!message || message.type !== 'RESERVATION') {
    return res.status(404).json({ message: '예약을 찾을 수 없어요.' });
  }
  const isMember = message.chatRoom.members.some((m) => m.userId === req.userId);
  if (!isMember) return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  if (message.reservationStatus !== 'CONFIRMED') {
    return res.status(409).json({ message: '확정된 예약만 취소할 수 있어요.' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.message.update({ where: { id: messageId }, data: { reservationStatus: 'CANCELLED' } });
    await tx.pinnedItem.deleteMany({ where: { sourceMessageId: messageId } });

    // 확정되면서 양쪽 캘린더에 생겼던 "약속" 일정을 실제로 지움 (안 지우면 취소해도 유령처럼 계속 남음)
    const linkedEvents = await tx.event.findMany({ where: { sourceMessageId: messageId, isPendingHold: false } });
    if (linkedEvents.length > 0) {
      await tx.event.deleteMany({ where: { id: { in: linkedEvents.map((e) => e.id) } } });
      // 지운 자리에, 그 사람이 원래 "예약 가능"으로 열어뒀던 시간이었다면 다시 예약 가능으로 복원함
      for (const ev of linkedEvents) {
        await restoreAvailabilityInRange(ev.userId, ev.startTime, ev.endTime, tx);
      }
    }
    return result;
  });

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// POST /api/chats/:roomId/location-suggestions   body: { place, note?, location?, locationLat?, locationLon?, immediate? }
// immediate=true면 협의 없이 바로 확정(핀 고정)까지 함 (기존 "바로 이 장소로 확정" 기능)
async function sendLocationSuggest(req, res) {
  const { roomId } = req.params;
  const { place, note, location, locationLat, locationLon, immediate } = req.body;

  if (!place || !place.trim()) {
    return res.status(400).json({ message: '제안할 장소를 입력해주세요.' });
  }
  const canMessage = await assertCanMessage(roomId, req.userId);
  if (!canMessage.ok) {
    return res.status(canMessage.statusCode).json({ message: canMessage.message });
  }

  const message = await prisma.message.create({
    data: {
      chatRoomId: roomId,
      senderId: req.userId,
      type: 'LOCATION_SUGGEST',
      locationPlace: place.trim(),
      locationNote: note || null,
      locationAddress: location || null,
      locationLat: typeof locationLat === 'number' ? locationLat : null,
      locationLon: typeof locationLon === 'number' ? locationLon : null,
      locationStatus: immediate ? 'CONFIRMED' : 'PENDING',
    },
  });

  if (immediate) {
    await prisma.pinnedItem.create({
      data: {
        chatRoomId: roomId,
        note: message.locationNote,
        location: message.locationPlace,
        sourceMessageId: message.id,
      },
    });
  }

  await notifyRoom(roomId, req.userId, 'newMessage', { roomId, message: serializeMessage(message) });
  return res.status(201).json({ message: serializeMessage(message) });
}

// POST /api/chats/location-suggestions/:messageId/accept 또는 /decline
// 받는 사람(보낸 사람이 아닌 멤버)만 처리할 수 있고, 수락하면 채팅방에 핀으로 고정됨
async function respondToLocationSuggest(req, res, status) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { chatRoom: { include: { members: true } } },
  });
  if (!message || message.type !== 'LOCATION_SUGGEST') {
    return res.status(404).json({ message: '장소 제안을 찾을 수 없어요.' });
  }
  const isMember = message.chatRoom.members.some((m) => m.userId === req.userId);
  if (!isMember) return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  if (message.senderId === req.userId) {
    return res.status(403).json({ message: '본인이 보낸 제안은 직접 수락/거절할 수 없어요.' });
  }
  if (message.locationStatus !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 제안이에요.' });
  }

  // 예약 수락/거절과 동일한 이유로, 상태가 여전히 PENDING일 때만 업데이트되게 조건을 걸어서
  // 거의 동시에(또는 빠르게 두 번 탭) 들어와도 딱 한 번만 처리되게 함 (안 그러면 핀이 중복 생길 수 있음)
  const { count } = await prisma.message.updateMany({
    where: { id: messageId, locationStatus: 'PENDING' },
    data: { locationStatus: status },
  });
  if (count === 0) {
    return res.status(409).json({ message: '이미 처리된 제안이에요.' });
  }
  const updated = await prisma.message.findUnique({ where: { id: messageId } });

  if (status === 'CONFIRMED') {
    await prisma.pinnedItem.create({
      data: {
        chatRoomId: message.chatRoomId,
        note: message.locationNote,
        location: message.locationPlace,
        sourceMessageId: message.id,
      },
    });
  }

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// POST /api/chats/location-suggestions/:messageId/withdraw — 보낸 사람이 대기중인 제안을 스스로 취소
async function withdrawLocationSuggest(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.type !== 'LOCATION_SUGGEST') {
    return res.status(404).json({ message: '장소 제안을 찾을 수 없어요.' });
  }
  if (message.senderId !== req.userId) {
    return res.status(403).json({ message: '본인이 보낸 제안만 취소할 수 있어요.' });
  }
  if (message.locationStatus !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 제안이에요.' });
  }

  const updated = await prisma.message.update({ where: { id: messageId }, data: { locationStatus: 'WITHDRAWN' } });
  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// POST /api/chats/location-suggestions/:messageId/cancel — 확정됐던 장소 제안을 취소 (핀도 함께 제거)
async function cancelLocationSuggestMessage(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { chatRoom: { include: { members: true } } } });
  if (!message || message.type !== 'LOCATION_SUGGEST') {
    return res.status(404).json({ message: '장소 제안을 찾을 수 없어요.' });
  }
  const isMember = message.chatRoom.members.some((m) => m.userId === req.userId);
  if (!isMember) return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  if (message.locationStatus !== 'CONFIRMED') {
    return res.status(409).json({ message: '확정된 제안만 취소할 수 있어요.' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.message.update({ where: { id: messageId }, data: { locationStatus: 'CANCELLED' } });
    await tx.pinnedItem.deleteMany({ where: { sourceMessageId: messageId } });
    return result;
  });

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// 어떤 후보든 방의 모든 멤버가 투표했으면 그걸로 확정 (모두의 캘린더에 일정 등록 + 핀 고정)
async function maybeConfirmProposal(message, roomId) {
  if (message.proposalStatus !== 'VOTING') return null;
  const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
  const members = await prisma.chatRoomMember.findMany({ where: { chatRoomId: roomId } });
  const totalMembers = members.length;

  // 1:1 방(그룹 아님)에서 후보가 여러 개면, 제안한 사람은 이미 "이 중 아무거나 괜찮다"는 뜻이라 상대가 하나만 골라도 바로 확정함
  // (그룹이거나 후보가 하나뿐이면 기존대로 전원 동의가 필요함)
  const isDirectPick = room && !room.isGroup && message.proposalOptions.length > 1;
  const threshold = isDirectPick ? 1 : totalMembers;

  const winner = message.proposalOptions.find((opt) => opt.votes.length >= threshold && totalMembers > 0);
  if (!winner) return null;

  const memberIds = members.map((m) => m.userId);

  return prisma.$transaction(async (tx) => {
    // proposalStatus가 여전히 VOTING일 때만 확정되도록 조건을 걸어서, 마지막 투표가 거의 동시에 두 번 들어와도
    // 딱 한 번만 확정 처리되게 함 (동시에 통과해서 일정이 중복 생성되는 경쟁 상태 방지)
    const { count } = await tx.message.updateMany({
      where: { id: message.id, proposalStatus: 'VOTING' },
      data: { proposalStatus: 'CONFIRMED' },
    });
    if (count === 0) return tx.message.findUnique({ where: { id: message.id }, include: PROPOSAL_INCLUDE });

    // 확정된 시간과 겹치는 "예약 가능" 표시를 정리 (안 그러면 같은 시간에 "예약 가능"이랑 "약속"이 같이 남아서 헷갈림)
    await clearAvailabilityInRange(memberIds, winner.startTime, winner.endTime, tx);

    await tx.event.createMany({
      data: members.map((m) => ({
        userId: m.userId,
        startTime: winner.startTime,
        endTime: winner.endTime,
        title: '약속',
        status: 'BUSY',
        // 확정된 약속은 기본적으로 "나만보기"로 등록되고, 이후 캘린더에서 직접 바꿀 수 있음
        visibleGroupIds: [],
        visiblePrivate: true,
        sourceMessageId: message.id,
        sourceChatRoomId: roomId,
      })),
    });

    await tx.pinnedItem.create({
      data: {
        chatRoomId: roomId,
        dateLabel: formatDateLabel(winner.startTime),
        timeLabel: formatTimeLabel(winner.startTime, winner.endTime),
        note: null,
        location: null,
        sourceMessageId: message.id,
      },
    });

    return tx.message.findUnique({ where: { id: message.id }, include: PROPOSAL_INCLUDE });
  });
}

// POST /api/chats/:roomId/time-proposals   body: { options: [{ start, end }, ...] }
// 그룹에 여러 시간 후보를 한 번에 제안 (후보가 하나뿐이면 제안한 사람이 자동으로 그 후보에 투표한 걸로 시작)
async function sendTimeProposal(req, res) {
  const { roomId } = req.params;
  const { options } = req.body;

  if (!Array.isArray(options) || options.length === 0) {
    return res.status(400).json({ message: '시간 후보를 하나 이상 선택해주세요.' });
  }
  const canMessage = await assertCanMessage(roomId, req.userId);
  if (!canMessage.ok) {
    return res.status(canMessage.statusCode).json({ message: canMessage.message });
  }

  const parsedOptions = [];
  for (const o of options) {
    const start = new Date(o.start);
    const end = new Date(o.end);
    if (isNaN(start) || isNaN(end) || end <= start) {
      return res.status(400).json({ message: '시간 후보 형식이 올바르지 않아요.' });
    }
    parsedOptions.push({ start, end });
  }

  const created = await prisma.message.create({
    data: {
      chatRoomId: roomId,
      senderId: req.userId,
      type: 'TIME_PROPOSAL',
      proposalStatus: 'VOTING',
      proposalOptions: { create: parsedOptions.map((o) => ({ startTime: o.start, endTime: o.end })) },
    },
    include: PROPOSAL_INCLUDE,
  });

  // 후보가 하나뿐이면 제안한 사람이 자동으로 그 후보에 투표한 걸로 시작 (나머지 멤버가 동의만 하면 확정)
  if (parsedOptions.length === 1) {
    await prisma.timeProposalVote.create({ data: { optionId: created.proposalOptions[0].id, userId: req.userId } });
  }

  const withVotes = await prisma.message.findUnique({ where: { id: created.id }, include: PROPOSAL_INCLUDE });
  const confirmed = await maybeConfirmProposal(withVotes, roomId);
  const final = confirmed || withVotes;

  await notifyRoom(roomId, req.userId, 'newMessage', { roomId, message: serializeMessage(final) });
  return res.status(201).json({ message: serializeMessage(final) });
}

// POST /api/chats/time-proposals/:messageId/vote   body: { optionId }
async function voteTimeProposal(req, res) {
  const { messageId } = req.params;
  const { optionId } = req.body;

  const message = await prisma.message.findUnique({ where: { id: messageId }, include: PROPOSAL_INCLUDE });
  if (!message || message.type !== 'TIME_PROPOSAL') {
    return res.status(404).json({ message: '시간 제안을 찾을 수 없어요.' });
  }
  if (!(await assertMembership(message.chatRoomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  if (message.proposalStatus !== 'VOTING') {
    return res.status(409).json({ message: '이미 끝난 제안이에요.' });
  }
  const option = message.proposalOptions.find((o) => o.id === optionId);
  if (!option) return res.status(404).json({ message: '해당 시간 후보를 찾을 수 없어요.' });

  // 한 사람은 한 후보에만 투표할 수 있음 - 다른 후보에 투표한 게 있으면 지우고 새로 투표
  await prisma.timeProposalVote.deleteMany({ where: { userId: req.userId, option: { messageId } } });
  await prisma.timeProposalVote.create({ data: { optionId, userId: req.userId } });

  const updated = await prisma.message.findUnique({ where: { id: messageId }, include: PROPOSAL_INCLUDE });
  const confirmed = await maybeConfirmProposal(updated, message.chatRoomId);
  const final = confirmed || updated;

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(final) });
  return res.json({ message: serializeMessage(final) });
}

// POST /api/chats/time-proposals/:messageId/cancel — 진행 중인 제안 자체를 취소 (아직 확정 전)
async function cancelTimeProposal(req, res) {
  const { messageId } = req.params;
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.type !== 'TIME_PROPOSAL') {
    return res.status(404).json({ message: '시간 제안을 찾을 수 없어요.' });
  }
  if (!(await assertMembership(message.chatRoomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  if (message.proposalStatus === 'CANCELLED') {
    return res.status(409).json({ message: '이미 취소된 제안이에요.' });
  }
  const wasConfirmed = message.proposalStatus === 'CONFIRMED';

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.message.update({
      where: { id: messageId },
      data: { proposalStatus: 'CANCELLED' },
      include: PROPOSAL_INCLUDE,
    });
    await tx.pinnedItem.deleteMany({ where: { sourceMessageId: messageId } }); // 확정돼서 핀이 있었으면 같이 제거

    // 이미 확정돼서 다들 캘린더에 "약속"이 생겨있던 상태였다면, 그 일정들도 실제로 지우고 예약가능을 복원함
    if (wasConfirmed) {
      const linkedEvents = await tx.event.findMany({ where: { sourceMessageId: messageId, isPendingHold: false } });
      if (linkedEvents.length > 0) {
        await tx.event.deleteMany({ where: { id: { in: linkedEvents.map((e) => e.id) } } });
        for (const ev of linkedEvents) {
          await restoreAvailabilityInRange(ev.userId, ev.startTime, ev.endTime, tx);
        }
      }
    }
    return result;
  });

  await notifyRoom(message.chatRoomId, req.userId, 'newMessage', { roomId: message.chatRoomId, message: serializeMessage(updated) });
  return res.json({ message: serializeMessage(updated) });
}

// 두 사람이 실제로(수락된 상태로) 친구인지 확인 - 친구 아닌 사람은 그룹에 못 넣게 막기 위함
async function areFriends(userIdA, userIdB) {
  const accepted = await prisma.friendRequest.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: userIdA, receiverId: userIdB },
        { senderId: userIdB, receiverId: userIdA },
      ],
    },
  });
  return !!accepted;
}

// POST /api/chats/group   body: { name, usernames: [...] }
// 나 + usernames로 지정한 친구들로 그룹 채팅방을 만든다 (친구가 아닌 사람은 넣을 수 없음)
async function createGroupRoom(req, res) {
  const { name, usernames } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: '모임 이름을 입력해주세요.' });
  }
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ message: '함께할 친구를 한 명 이상 선택해주세요.' });
  }

  const normalized = [...new Set(usernames.map((u) => String(u).trim().toLowerCase()))];
  const users = await prisma.user.findMany({ where: { username: { in: normalized } } });
  if (users.length !== normalized.length) {
    return res.status(404).json({ message: '일부 사용자를 찾을 수 없어요.' });
  }

  for (const user of users) {
    if (user.id === req.userId) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await areFriends(req.userId, user.id);
    if (!ok) {
      return res.status(403).json({ message: `${user.name}님과는 친구가 아니라 그룹에 넣을 수 없어요.` });
    }
  }

  const memberIds = [...new Set([req.userId, ...users.map((u) => u.id)])];

  const room = await prisma.chatRoom.create({
    data: {
      isGroup: true,
      name: name.trim(),
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });

  return res.status(201).json({ roomId: room.id });
}

// POST /api/chats/:roomId/leave
// 채팅방에서 나감 (내 멤버십만 삭제, 남은 멤버가 없으면 방 자체도 정리)
async function leaveRoom(req, res) {
  const { roomId } = req.params;

  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 속해있지 않아요.' });
  }

  await prisma.chatRoomMember.delete({
    where: { chatRoomId_userId: { chatRoomId: roomId, userId: req.userId } },
  });

  const remaining = await prisma.chatRoomMember.count({ where: { chatRoomId: roomId } });
  if (remaining === 0) {
    await prisma.chatRoom.delete({ where: { id: roomId } });
  }

  return res.json({ message: '채팅방을 나갔어요.' });
}

const acceptReservation = (req, res) => respondToReservation(req, res, 'CONFIRMED');
const declineReservation = (req, res) => respondToReservation(req, res, 'DECLINED');
const acceptLocationSuggest = (req, res) => respondToLocationSuggest(req, res, 'CONFIRMED');
const declineLocationSuggest = (req, res) => respondToLocationSuggest(req, res, 'DECLINED');

// GET /api/chats/:roomId/pins — 이 방에 고정해둔 확정 일정/장소 목록
async function listPins(req, res) {
  const { roomId } = req.params;
  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  const pins = await prisma.pinnedItem.findMany({
    where: { chatRoomId: roomId },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ pins });
}

// POST /api/chats/:roomId/pins   body: { dateLabel?, timeLabel?, note?, location?, sourceMessageId? }
async function createPin(req, res) {
  const { roomId } = req.params;
  if (!(await assertMembership(roomId, req.userId))) {
    return res.status(403).json({ message: '이 채팅방에 접근할 권한이 없어요.' });
  }
  const { dateLabel, timeLabel, note, location, sourceMessageId } = req.body;
  const pin = await prisma.pinnedItem.create({
    data: {
      chatRoomId: roomId,
      dateLabel: dateLabel || null,
      timeLabel: timeLabel || null,
      note: note || null,
      location: location || null,
      sourceMessageId: sourceMessageId || null,
    },
  });
  return res.status(201).json({ pin });
}

// PATCH /api/chats/pins/:pinId   body: { location? }  - 핀에 장소만 나중에 추가/수정할 때 사용
async function updatePin(req, res) {
  const { pinId } = req.params;
  const pin = await prisma.pinnedItem.findUnique({ where: { id: pinId } });
  if (!pin || !(await assertMembership(pin.chatRoomId, req.userId))) {
    return res.status(404).json({ message: '핀을 찾을 수 없어요.' });
  }
  const { location } = req.body;
  const updated = await prisma.pinnedItem.update({
    where: { id: pinId },
    data: { location: location !== undefined ? location : undefined },
  });
  return res.json({ pin: updated });
}

// DELETE /api/chats/pins/:pinId
async function deletePin(req, res) {
  const { pinId } = req.params;
  const pin = await prisma.pinnedItem.findUnique({ where: { id: pinId } });
  if (!pin || !(await assertMembership(pin.chatRoomId, req.userId))) {
    return res.status(404).json({ message: '핀을 찾을 수 없어요.' });
  }
  await prisma.pinnedItem.delete({ where: { id: pinId } });
  return res.json({ message: '핀을 삭제했어요.' });
}

module.exports = {
  listChatRooms,
  getOrCreateDirectRoom,
  listMessages,
  sendTextMessage,
  sendImageMessage,
  sendReservationRequest,
  acceptReservation,
  declineReservation,
  withdrawReservation,
  cancelReservationMessage,
  sendTimeProposal,
  voteTimeProposal,
  cancelTimeProposal,
  sendLocationSuggest,
  acceptLocationSuggest,
  declineLocationSuggest,
  withdrawLocationSuggest,
  cancelLocationSuggestMessage,
  createGroupRoom,
  leaveRoom,
  markRoomRead,
  setRoomMuted,
  listPins,
  createPin,
  updatePin,
  deletePin,
};
