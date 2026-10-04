// 외부 캘린더 주소(ICS)를 대신 받아오기 - 브라우저는 다른 사이트의 캘린더 파일을 직접 못 읽어서(CORS) 서버가 받아다 줌.
// 아무 주소나 받아오게 하면 서버 내부망을 찔러보는 통로(SSRF)가 되니까, 캘린더 서비스 주소만 허용하고
// 리다이렉트도 따라가기 전에 매번 같은 허용 목록으로 다시 확인함. 파싱은 프론트에서 함(파일 업로드와 같은 코드).
const ALLOWED_HOSTS = [
  /^calendar\.google\.com$/,
  /^([a-z0-9-]+\.)*icloud\.com$/, // 아이폰 "공개 캘린더" 링크 (p01-caldav.icloud.com 등)
  /^outlook\.(live|office365|office)\.com$/,
  /^calendar\.naver\.com$/,
];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function normalizeIcsUrl(raw) {
  let s = String(raw || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))) return null;
  return u;
}

async function fetchIcs(rawUrl) {
  let url = normalizeIcsUrl(rawUrl);
  if (!url) {
    const err = new Error('구글·아이폰(iCloud)·아웃룩 캘린더 주소만 불러올 수 있어요.');
    err.status = 400;
    throw err;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'text/calendar, */*' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = normalizeIcsUrl(new URL(res.headers.get('location'), url).toString());
      if (!url) break;
      continue;
    }
    if (!res.ok) {
      const err = new Error(res.status === 404 || res.status === 403
        ? '캘린더를 찾을 수 없어요. 주소가 맞는지, 공개(또는 비공개 주소)로 되어 있는지 확인해 주세요.'
        : '캘린더를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      err.status = 400;
      throw err;
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) break;
    // eslint-disable-next-line no-await-in-loop
    const text = await res.text();
    if (text.length > MAX_BYTES) break;
    if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) {
      const err = new Error('캘린더 주소가 아닌 것 같아요. "iCal 형식" 주소를 붙여넣어 주세요.');
      err.status = 400;
      throw err;
    }
    return text;
  }
  const err = new Error('캘린더를 불러오지 못했어요. 주소를 다시 확인해 주세요.');
  err.status = 400;
  throw err;
}

module.exports = { fetchIcs };
