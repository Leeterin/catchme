const prisma = require('../lib/prisma');

const DEFAULTS = {
  darkMode: false,
  defaultScheduleView: 'month',
  privCalendarPublic: false,
  privStrangerChat: false,
  notifMessage: true,
  notifFriendreq: true,
  notifMatched: true,
  notifMarketing: false,
  friendAutoaccept: false,
  friendSearchAllow: true,
  chatReadReceipt: true,
  chatPreview: true,
};

function serializeSettings(s) {
  return {
    darkMode: s.darkMode,
    defaultScheduleView: s.defaultScheduleView,
    privCalendarPublic: s.privCalendarPublic,
    privStrangerChat: s.privStrangerChat,
    notifMessage: s.notifMessage,
    notifFriendreq: s.notifFriendreq,
    notifMatched: s.notifMatched,
    notifMarketing: s.notifMarketing,
    friendAutoaccept: s.friendAutoaccept,
    friendSearchAllow: s.friendSearchAllow,
    chatReadReceipt: s.chatReadReceipt,
    chatPreview: s.chatPreview,
  };
}

// GET /api/settings — 없으면 기본값으로 하나 만들어서 돌려줌
async function getSettings(req, res) {
  let settings = await prisma.userSettings.findUnique({ where: { userId: req.userId } });
  if (!settings) {
    settings = await prisma.userSettings.create({ data: { userId: req.userId, ...DEFAULTS } });
  }
  return res.json({ settings: serializeSettings(settings) });
}

// PATCH /api/settings   body: 바꿀 값들만 (위 DEFAULTS 키 중 아무거나)
async function updateSettings(req, res) {
  const data = {};
  Object.keys(DEFAULTS).forEach((key) => {
    if (req.body[key] !== undefined) {
      if (key === 'defaultScheduleView') {
        if (['day', 'week', 'month'].includes(req.body[key])) data[key] = req.body[key];
      } else if (typeof req.body[key] === 'boolean') {
        data[key] = req.body[key];
      }
    }
  });

  const settings = await prisma.userSettings.upsert({
    where: { userId: req.userId },
    update: data,
    create: { userId: req.userId, ...DEFAULTS, ...data },
  });

  return res.json({ settings: serializeSettings(settings) });
}

module.exports = { getSettings, updateSettings };
