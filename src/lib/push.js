// 휴대폰 푸시 알림(FCM) 발송.
// FIREBASE_SERVICE_ACCOUNT 환경변수(서비스 계정 JSON 원문 또는 base64)가 없으면 아무것도 안 보내고 조용히 넘어감.
const prisma = require('./prisma');

let messaging = null;
let initTried = false;

function getMessaging() {
  if (initTried) return messaging;
  initTried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const admin = require('firebase-admin');
    const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
    messaging = admin.messaging(app);
  } catch (err) {
    console.error('[push] Firebase 초기화 실패', err.message);
  }
  return messaging;
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// userIds에게 푸시 발송. 'CATCHME 푸시 알림 받기'(notifMessage)를 끈 사람은 제외.
// data 값은 FCM 규칙상 모두 문자열이어야 함.
async function sendPushToUsers(userIds, { title, body, data = {} }) {
  try {
    const fcm = getMessaging();
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!fcm || ids.length === 0) return;

    const optedOut = await prisma.userSettings.findMany({
      where: { userId: { in: ids }, notifMessage: false },
      select: { userId: true },
    });
    const blocked = new Set(optedOut.map((s) => s.userId));
    const targets = ids.filter((id) => !blocked.has(id));
    if (targets.length === 0) return;

    const rows = await prisma.pushToken.findMany({ where: { userId: { in: targets } }, select: { token: true } });
    const tokens = rows.map((r) => r.token);
    if (tokens.length === 0) return;

    const stringData = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    );
    const res = await fcm.sendEachForMulticast({
      tokens,
      notification: { title, body: String(body || '').slice(0, 200) },
      data: stringData,
      android: { priority: 'high', notification: { channelId: 'catchme_default', sound: 'default' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
    });
    if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
  } catch (err) {
    console.error('[push] 발송 실패', err.message);
  }
}

// 응답을 기다리게 하지 않도록 백그라운드로 발송
function pushInBackground(userIds, message) {
  sendPushToUsers(userIds, message).catch(() => {});
}

module.exports = { sendPushToUsers, pushInBackground };
