const prisma = require('../lib/prisma');

const DEFAULTS = {
  darkMode: false,
  defaultScheduleView: 'month',
  privCalendarPublic: false,
  privStrangerChat: true,
  notifMessage: true,
  notifFriendreq: true,
  notifMatched: true,
  notifMarketing: false,
  friendAutoaccept: false,
  friendSearchAllow: true,
  chatReadReceipt: true,
  chatPreview: true,
  workEmoji: '💼',
  colorLabels: [],
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
    workEmoji: s.workEmoji,
    colorLabels: s.colorLabels,
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
      } else if (key === 'workEmoji') {
        // 업무용 링크 이모티콘 - 하나만 받고, 비우면 기본 💼로
        const v = String(req.body[key] || '').trim();
        const graphemes = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(v)];
        if (!v) data[key] = '💼';
        else if (v.length <= 16 && graphemes.length === 1) data[key] = v;
      } else if (key === 'colorLabels') {
        // 일정 색 라벨 이름 - 10개까지, 하나당 12자까지 (빈칸은 기본 이름)
        if (Array.isArray(req.body[key])) {
          data[key] = req.body[key].slice(0, 10).map((n) => (typeof n === 'string' ? n.trim().slice(0, 12) : ''));
        }
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
