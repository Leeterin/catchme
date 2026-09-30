const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/; // 소문자로 시작, 3~20자, 영문 소문자/숫자/./_
const PHONE_RE = /^01[016789]-?\d{3,4}-?\d{4}$/; // 한국 휴대폰 번호 형식 (하이픈 선택)

// 업로드 이미지로 허용하는 MIME 타입 - png/jpeg/webp/gif만 허용하고 svg는 일부러 제외함.
// svg는 내부에 <script>를 심을 수 있는데, 업로드된 이미지를 인증 없이 그대로 서빙하는 구조라
// svg를 허용하면 누구나 자기 프로필/게시물 사진에 스크립트를 심어 저장형 XSS를 만들 수 있음.
const ALLOWED_IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;

function isAllowedImageDataUrl(value) {
  return typeof value === 'string' && ALLOWED_IMAGE_DATA_URL_RE.test(value);
}

function validateSignupInput({ email, username, name, password, phone }) {
  const errors = {};

  if (!email || !EMAIL_RE.test(email)) {
    errors.email = '올바른 이메일 형식이 아니에요.';
  }

  if (!username || !USERNAME_RE.test(username)) {
    errors.username = '아이디는 영문 소문자로 시작하는 3~20자(영문/숫자/./_)여야 해요.';
  }

  if (!name || name.trim().length === 0 || name.trim().length > 20) {
    errors.name = '이름을 1~20자 이내로 입력해주세요.';
  }

  if (!password || password.length < 8) {
    errors.password = '비밀번호는 최소 8자 이상이어야 해요.';
  } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.password = '비밀번호는 영문과 숫자를 하나 이상 포함해야 해요.';
  }

  if (phone && !PHONE_RE.test(phone)) {
    errors.phone = '올바른 휴대폰 번호 형식이 아니에요. (예: 010-1234-5678)';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = { validateSignupInput, EMAIL_RE, USERNAME_RE, PHONE_RE, ALLOWED_IMAGE_DATA_URL_RE, isAllowedImageDataUrl };
