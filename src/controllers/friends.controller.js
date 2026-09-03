const prisma = require('../lib/prisma');
const { getIo } = require('../lib/socket');
const { distanceKm } = require('../lib/geo');

// 특정 유저(userId)한테 실시간 알림을 보냄. 그 유저가 지금 접속중이 아니면 그냥 조용히 무시됨(다음 접속/새로고침 때 REST로 최신 상태를 받아가니까 문제없음)
function notifyUser(userId, event, payload) {
  const io = getIo();
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

const SELF_SELECT = {
  id: true,
  username: true,
  name: true,
  profileImageUrl: true,
  bio: true,
  phone: true,
  email: true,
  phonePublic: true,
  emailPublic: true,
};

// 상대방이 공개로 설정한 필드만 내려준다 (프라이버시 원칙)
function toPublicProfile(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    hasAvatar: !!user.profileImageUrl, // 사진 원본(base64)은 안 보내고, 있는지 여부만 알려줌 - 실제 이미지는 캐싱되는 /api/users/:id/avatar 로 따로 받음
    bio: user.bio,
    phone: user.phonePublic ? user.phone : null,
    email: user.emailPublic ? user.email : null,
  };
}

// GET /api/friends/search?query=abc
// 아이디(username)로 유저를 검색. 본인 제외, "아이디로 검색 허용"을 꺼둔 사람도 제외.
async function searchUsers(req, res) {
  const query = String(req.query.query || '').trim().toLowerCase();
  if (!query) return res.json({ users: [] });

  // 내가 차단했거나 나를 차단한 사람은 검색 결과에서도 안 보이게 함
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: req.userId }, { blockedId: req.userId }] },
  });
  const blockedIds = new Set();
  blocks.forEach((b) => {
    blockedIds.add(b.blockerId === req.userId ? b.blockedId : b.blockerId);
  });

  const users = await prisma.user.findMany({
    where: {
      username: { contains: query, mode: 'insensitive' },
      NOT: { id: { in: [req.userId, ...blockedIds] } },
      OR: [{ settings: null }, { settings: { friendSearchAllow: true } }],
    },
    select: SELF_SELECT,
    take: 20,
  });

  return res.json({ users: users.map(toPublicProfile) });
}

// 두 사람 사이에 차단이 있는지 (어느 방향이든) 확인
async function isBlockedEitherWay(userIdA, userIdB) {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA },
      ],
    },
  });
  return !!block;
}

// GET /api/friends
// 수락된(ACCEPTED) 친구 요청을 기준으로 내 친구 목록을 만든다.
async function listFriends(req, res) {
  const accepted = await prisma.friendRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: req.userId }, { receiverId: req.userId }],
    },
    include: {
      sender: { select: SELF_SELECT },
      receiver: { select: SELF_SELECT },
    },
    orderBy: { respondedAt: 'desc' },
  });

  const settingsRows = await prisma.friendSettings.findMany({ where: { ownerId: req.userId } });
  const settingsMap = {};
  settingsRows.forEach((s) => { settingsMap[s.friendId] = s; });

  // 이 친구들이 각각 내 어떤 그룹(들)에 들어있는지도 같이 내려줌 (친구 프로필에서 "속한 그룹" 표시용)
  const otherIds = accepted.map((fr) => (fr.senderId === req.userId ? fr.receiverId : fr.senderId));
  const memberships = await prisma.friendGroupMember.findMany({
    where: { friendId: { in: otherIds }, group: { ownerId: req.userId } },
    select: { friendId: true, groupId: true },
  });
  const groupIdsByFriend = {};
  memberships.forEach((m) => {
    if (!groupIdsByFriend[m.friendId]) groupIdsByFriend[m.friendId] = [];
    groupIdsByFriend[m.friendId].push(m.groupId);
  });

  const friends = accepted.map((fr) => {
    const other = fr.senderId === req.userId ? fr.receiver : fr.sender;
    const row = settingsMap[other.id];
    return {
      ...toPublicProfile(other),
      privateAccess: row ? row.privateAccess : false,
      groupIds: groupIdsByFriend[other.id] || [],
    };
  });

  return res.json({ friends });
}

// GET /api/friends/nearby?lat=&lon=&radiusKm=
// 주어진 기준 위치에서 반경 안에 있는 친구만 추려서 반환 (친구가 "현위치"를 한 번이라도 써서 위치를 공유해둔 경우에만 대상이 됨)
// GET /api/friends/nearby?lat=&lon=&radiusKm=
// 친구인지 여부와 무관하게, "위치 공유 동의"를 해두고 반경 안에 있는 회원을 전부 반환함.
// 이미 친구인 사람은 isFriend:true로 표시되고, 프론트에서 "친구 목록에 없는 사람"만 추려내면 추천 후보가 됨.
async function nearbyFriends(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radiusKm = parseFloat(req.query.radiusKm) || 5;
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ message: '기준 위치 좌표가 필요해요.' });
  }

  const [accepted, blocks, nearbyCandidates] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
    }),
    prisma.block.findMany({ where: { OR: [{ blockerId: req.userId }, { blockedId: req.userId }] } }),
    prisma.user.findMany({
      where: {
        id: { not: req.userId },
        locationSharing: true,
        lastLat: { not: null },
        lastLon: { not: null },
      },
      select: { ...SELF_SELECT, lastLat: true, lastLon: true },
    }),
  ]);

  const friendIdSet = new Set(
    accepted.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId))
  );
  const blockedIds = new Set();
  blocks.forEach((b) => blockedIds.add(b.blockerId === req.userId ? b.blockedId : b.blockerId));

  const users = nearbyCandidates
    .filter((u) => !blockedIds.has(u.id))
    .map((u) => ({
      ...toPublicProfile(u),
      isFriend: friendIdSet.has(u.id),
      distanceKm: distanceKm(lat, lon, u.lastLat, u.lastLon),
    }))
    .filter((u) => u.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return res.json({ users });
}

// 내 친구가 맞는지 확인하는 공용 헬퍼
async function isFriendOf(userIdA, userIdB) {
  const row = await prisma.friendRequest.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: userIdA, receiverId: userIdB },
        { senderId: userIdB, receiverId: userIdA },
      ],
    },
  });
  return !!row;
}

// PATCH /api/friends/:friendId/private-access   body: { enabled }
// 이 친구한테 내 "나만보기" 일정도 보여줄지 (연인 등 - 특정 한두 명한테만 켜는 용도)
async function setPrivateAccess(req, res) {
  const { friendId } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled는 true/false여야 해요.' });
  }

  if (!(await isFriendOf(req.userId, friendId))) return res.status(404).json({ message: '친구 관계가 아니에요.' });

  await prisma.friendSettings.upsert({
    where: { ownerId_friendId: { ownerId: req.userId, friendId } },
    update: { privateAccess: enabled },
    create: { ownerId: req.userId, friendId, privateAccess: enabled },
  });

  return res.json({ message: enabled ? '이 친구에게 나만보기 일정도 보여줘요.' : '이 친구에게 나만보기 일정을 다시 숨겼어요.', privateAccess: enabled });
}

// ------------------------------------------------------------
// 친구 그룹 (인스타 "친한 친구"처럼, 내가 이름 붙여 만드는 친구 그룹 - 일정을 이 그룹에만 공개할 수 있음)
// ------------------------------------------------------------

function serializeGroup(group) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    memberIds: (group.members || []).map((m) => m.friendId),
  };
}

// GET /api/friends/groups
async function listGroups(req, res) {
  const groups = await prisma.friendGroup.findMany({
    where: { ownerId: req.userId },
    include: { members: { select: { friendId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ groups: groups.map(serializeGroup) });
}

// POST /api/friends/groups   body: { name }
async function createGroup(req, res) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: '그룹 이름을 입력해주세요.' });
  if (name.length > 20) return res.status(400).json({ message: '그룹 이름은 20자 이내로 입력해주세요.' });

  const group = await prisma.friendGroup.create({
    data: { ownerId: req.userId, name },
    include: { members: { select: { friendId: true } } },
  });
  return res.status(201).json({ group: serializeGroup(group) });
}

// PATCH /api/friends/groups/:groupId   body: { name }
async function renameGroup(req, res) {
  const { groupId } = req.params;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: '그룹 이름을 입력해주세요.' });
  if (name.length > 20) return res.status(400).json({ message: '그룹 이름은 20자 이내로 입력해주세요.' });

  const group = await prisma.friendGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.userId) return res.status(404).json({ message: '그룹을 찾을 수 없어요.' });

  const updated = await prisma.friendGroup.update({
    where: { id: groupId },
    data: { name },
    include: { members: { select: { friendId: true } } },
  });
  return res.json({ group: serializeGroup(updated) });
}

// DELETE /api/friends/groups/:groupId
// 이 그룹을 지우면, 이 그룹으로만 공개돼있던 일정들은 자동으로 "나만보기"가 되지 않게 - 그냥 그 그룹 id가 더 이상
// 아무도 못 통과하는 채로 남는 셈이라, 사실상 그 일정을 볼 수 있는 사람이 아무도 없어짐. 그래서 삭제 전에 미리 알려줌.
async function deleteGroup(req, res) {
  const { groupId } = req.params;
  const group = await prisma.friendGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.userId) return res.status(404).json({ message: '그룹을 찾을 수 없어요.' });

  await prisma.friendGroup.delete({ where: { id: groupId } });

  // 이 그룹으로 공개돼있던 일정들에서, 이 그룹 id만 쏙 빼줌 (일정이 다른 그룹도 같이 갖고 있었으면 그건 그대로 유지 -
  // 한 일정이 여러 그룹에 동시에 공개될 수 있어서, updateMany로 통째로 밀어버리면 안 되고 하나씩 걸러서 고쳐야 함)
  const affected = await prisma.event.findMany({
    where: { userId: req.userId, visibleGroupIds: { has: groupId } },
    select: { id: true, visibleGroupIds: true },
  });
  await Promise.all(
    affected.map((ev) =>
      prisma.event.update({
        where: { id: ev.id },
        data: { visibleGroupIds: ev.visibleGroupIds.filter((id) => id !== groupId) },
      })
    )
  );

  return res.json({ message: '그룹을 삭제했어요.' });
}

// PUT /api/friends/groups/:groupId/members   body: { friendIds: string[] }
// 이 그룹의 멤버 목록을 통째로 교체함 (체크박스로 한 번에 저장하는 UI에 맞춤)
async function setGroupMembers(req, res) {
  const { groupId } = req.params;
  const friendIds = Array.isArray(req.body.friendIds) ? req.body.friendIds : null;
  if (!friendIds) return res.status(400).json({ message: 'friendIds는 배열이어야 해요.' });

  const group = await prisma.friendGroup.findUnique({ where: { id: groupId } });
  if (!group || group.ownerId !== req.userId) return res.status(404).json({ message: '그룹을 찾을 수 없어요.' });

  // 실제 내 친구만 담기게, 요청에 섞여있을 수 있는 친구 아닌 id는 걸러냄
  const accepted = await prisma.friendRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: req.userId }, { receiverId: req.userId }],
    },
  });
  const myFriendIds = new Set(
    accepted.map((r) => (r.senderId === req.userId ? r.receiverId : r.senderId))
  );
  const validIds = [...new Set(friendIds)].filter((id) => myFriendIds.has(id));

  await prisma.$transaction([
    prisma.friendGroupMember.deleteMany({ where: { groupId } }),
    prisma.friendGroupMember.createMany({
      data: validIds.map((friendId) => ({ groupId, friendId })),
    }),
  ]);

  const updated = await prisma.friendGroup.findUnique({
    where: { id: groupId },
    include: { members: { select: { friendId: true } } },
  });
  return res.json({ group: serializeGroup(updated) });
}

// GET /api/friends/requests
// 내가 받은(incoming) / 보낸(outgoing) 대기중인 요청을 함께 반환
async function listRequests(req, res) {
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { receiverId: req.userId, status: 'PENDING' },
      include: { sender: { select: SELF_SELECT } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.friendRequest.findMany({
      where: { senderId: req.userId, status: 'PENDING' },
      include: { receiver: { select: SELF_SELECT } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return res.json({
    incoming: incoming.map((r) => ({ requestId: r.id, from: toPublicProfile(r.sender), createdAt: r.createdAt })),
    outgoing: outgoing.map((r) => ({ requestId: r.id, to: toPublicProfile(r.receiver), createdAt: r.createdAt })),
  });
}

// POST /api/friends/requests   body: { username }
async function sendRequest(req, res) {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: '친구의 아이디를 입력해주세요.' });

  const receiver = await prisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!receiver) return res.status(404).json({ message: '해당 아이디의 유저를 찾을 수 없어요.' });
  if (receiver.id === req.userId) {
    return res.status(400).json({ message: '자기 자신에게는 친구 요청을 보낼 수 없어요.' });
  }

  if (await isBlockedEitherWay(req.userId, receiver.id)) {
    return res.status(403).json({ message: '친구 요청을 보낼 수 없는 사용자예요.' });
  }

  // 상대방이 "친구 요청 자동 수락"을 켜뒀으면, 대기 상태를 거치지 않고 바로 친구가 됨
  const receiverSettings = await prisma.userSettings.findUnique({ where: { userId: receiver.id } });
  const autoAccept = !!(receiverSettings && receiverSettings.friendAutoaccept);

  // "이미 요청이 있는지 확인 -> 없으면 생성"이 원자적이지 않으면, 두 사람이 거의 동시에 서로에게
  // 요청을 보낼 때 둘 다 "없음"을 보고 그대로 진행해서 반대 방향 요청이 중복으로 남을 수 있음
  // (senderId/receiverId 유니크 제약은 같은 방향 중복만 막아줌). Serializable 트랜잭션으로 묶어서
  // 이런 경쟁이 생기면 DB가 둘 중 하나를 실패시키게 하고, 그 실패를 잡아서 409로 자연스럽게 응답함.
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const existing = await tx.friendRequest.findFirst({
        where: {
          OR: [
            { senderId: req.userId, receiverId: receiver.id },
            { senderId: receiver.id, receiverId: req.userId },
          ],
        },
      });

      if (existing) {
        if (existing.status === 'ACCEPTED') {
          return { conflict: '이미 친구예요.' };
        }
        if (existing.status === 'PENDING') {
          return { conflict: '이미 친구 요청을 보냈거나 받은 상태예요.' };
        }
        // 예전에 거절됐던 요청이면 다시 PENDING(또는 자동수락이면 ACCEPTED)으로 재사용
        const revived = await tx.friendRequest.update({
          where: { id: existing.id },
          data: {
            status: autoAccept ? 'ACCEPTED' : 'PENDING',
            senderId: req.userId,
            receiverId: receiver.id,
            respondedAt: autoAccept ? new Date() : null,
          },
        });
        return { requestId: revived.id };
      }

      const created = await tx.friendRequest.create({
        data: {
          senderId: req.userId,
          receiverId: receiver.id,
          status: autoAccept ? 'ACCEPTED' : 'PENDING',
          respondedAt: autoAccept ? new Date() : null,
        },
      });
      return { requestId: created.id };
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    // Postgres가 serializable 충돌을 감지해서 트랜잭션을 실패시킨 경우 - 진짜로 거의 동시에 서로
    // 요청을 보낸 드문 경우이므로, 500이 아니라 다시 시도해달라는 안내로 자연스럽게 응답함
    if (err.code === 'P2034') {
      return res.status(409).json({ message: '거의 동시에 요청이 처리됐어요. 잠시 후 다시 시도해주세요.' });
    }
    throw err;
  }

  if (result.conflict) {
    return res.status(409).json({ message: result.conflict });
  }
  // 받는 사람한테 실시간으로 알려줘서, 새로고침 안 해도 "받은 요청" 목록에 바로 뜨게 함
  notifyUser(receiver.id, autoAccept ? 'friendsChanged' : 'friendRequestReceived', {});
  return res.status(201).json({
    message: autoAccept ? '친구가 됐어요! (상대방이 자동 수락을 켜뒀어요)' : '친구 요청을 보냈어요.',
    requestId: result.requestId,
  });
}

async function respondToRequest(req, res, status) {
  const { requestId } = req.params;

  const request = await prisma.friendRequest.findUnique({ where: { id: requestId } });
  if (!request) return res.status(404).json({ message: '요청을 찾을 수 없어요.' });
  if (request.receiverId !== req.userId) {
    return res.status(403).json({ message: '이 요청에 응답할 권한이 없어요.' });
  }
  if (request.status !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 요청이에요.' });
  }

  const updated = await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status, respondedAt: new Date() },
  });

  // 요청 보낸 사람한테 실시간으로 알려줘서, 새로고침 안 해도 결과가 바로 반영되게 함
  notifyUser(request.senderId, status === 'ACCEPTED' ? 'friendsChanged' : 'friendRequestDeclined', {});

  const message = status === 'ACCEPTED' ? '친구 요청을 수락했어요.' : '친구 요청을 거절했어요.';
  return res.json({ message, requestId: updated.id, status: updated.status });
}

const acceptRequest = (req, res) => respondToRequest(req, res, 'ACCEPTED');
const declineRequest = (req, res) => respondToRequest(req, res, 'DECLINED');

// DELETE /api/friends/requests/:requestId — 내가 보낸 대기중인 요청을 스스로 취소
async function cancelRequest(req, res) {
  const { requestId } = req.params;
  const request = await prisma.friendRequest.findUnique({ where: { id: requestId } });
  if (!request) return res.status(404).json({ message: '요청을 찾을 수 없어요.' });
  if (request.senderId !== req.userId) {
    return res.status(403).json({ message: '본인이 보낸 요청만 취소할 수 있어요.' });
  }
  if (request.status !== 'PENDING') {
    return res.status(409).json({ message: '이미 처리된 요청이에요.' });
  }
  await prisma.friendRequest.delete({ where: { id: requestId } });
  notifyUser(request.receiverId, 'friendRequestCancelled', {});
  return res.json({ message: '친구 요청을 취소했어요.' });
}

// DELETE /api/friends/:friendId — 친구 끊기 (수락된 관계 삭제)
async function removeFriend(req, res) {
  const { friendId } = req.params;

  const relation = await prisma.friendRequest.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: req.userId, receiverId: friendId },
        { senderId: friendId, receiverId: req.userId },
      ],
    },
  });

  if (!relation) return res.status(404).json({ message: '친구 관계를 찾을 수 없어요.' });

  await prisma.friendRequest.delete({ where: { id: relation.id } });
  return res.json({ message: '친구를 삭제했어요.' });
}

// POST /api/friends/block   body: { username } — 차단하면 서로 친구관계/대기중 요청도 정리됨
async function blockUser(req, res) {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: '차단할 아이디를 입력해주세요.' });

  const target = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!target) return res.status(404).json({ message: '해당 아이디의 유저를 찾을 수 없어요.' });
  if (target.id === req.userId) return res.status(400).json({ message: '자기 자신은 차단할 수 없어요.' });

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId: req.userId, blockedId: target.id } },
    update: {},
    create: { blockerId: req.userId, blockedId: target.id },
  });

  // 차단하면 친구관계/대기중 요청도 함께 정리
  await prisma.friendRequest.deleteMany({
    where: {
      OR: [
        { senderId: req.userId, receiverId: target.id },
        { senderId: target.id, receiverId: req.userId },
      ],
    },
  });

  return res.json({ message: `${target.name}님을 차단했어요.` });
}

// POST /api/friends/unblock   body: { username }
async function unblockUser(req, res) {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: '차단 해제할 아이디를 입력해주세요.' });

  const target = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!target) return res.status(404).json({ message: '해당 아이디의 유저를 찾을 수 없어요.' });

  await prisma.block.deleteMany({ where: { blockerId: req.userId, blockedId: target.id } });
  return res.json({ message: '차단을 해제했어요.' });
}

// GET /api/friends/blocks — 내가 차단한 사람 목록
async function listBlocks(req, res) {
  const blocks = await prisma.block.findMany({
    where: { blockerId: req.userId },
    include: { blocked: { select: SELF_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ blocked: blocks.map((b) => toPublicProfile(b.blocked)) });
}

module.exports = {
  searchUsers,
  listFriends,
  nearbyFriends,
  listRequests,
  sendRequest,
  acceptRequest,
  declineRequest,
  cancelRequest,
  removeFriend,
  blockUser,
  unblockUser,
  listBlocks,
  setPrivateAccess,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupMembers,
};
