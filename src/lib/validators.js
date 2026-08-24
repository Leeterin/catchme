const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/; // 소문자로 시작, 3~20자, 영문 소문자/숫자/./_
const PHONE_RE = /^01[016789]-?\d{3,4}-?\d{4}$/; // 한국 휴대폰 번호 형식 (하이픈 선택)

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

module.exports = { validateSignupInput, EMAIL_RE, USERNAME_RE, PHONE_RE };
