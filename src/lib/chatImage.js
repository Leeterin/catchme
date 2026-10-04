const crypto = require('crypto');

// 채팅 사진 주소 - 예전엔 사진 원본(base64)을 메시지에 그대로 넣어 보내서, 사진 많은 방은 열 때마다 수십 MB를 다시 받았음.
// 이제 메시지엔 주소만 넣고 사진은 따로 받아서 휴대폰에 캐시해둠.
// <img>는 로그인 헤더를 못 보내니, 서버만 아는 비밀키로 만든 서명(s)을 주소에 붙여서 그 방 사람들이 받은 주소로만 열리게 함
const API_ORIGIN = (process.env.PUBLIC_API_ORIGIN || process.env.BACKEND_URL || 'https://catchme-backend-d7vh.onrender.com').replace(/\/+$/, '');

function chatImageSig(messageId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`chat-image:${messageId}`).digest('hex').slice(0, 32);
}

function chatImageUrl(messageId) {
  return `${API_ORIGIN}/api/chat-images/${messageId}?s=${chatImageSig(messageId)}`;
}

function isValidChatImageSig(messageId, sig) {
  if (typeof sig !== 'string') return false;
  const expected = Buffer.from(chatImageSig(messageId));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { chatImageUrl, isValidChatImageSig };
