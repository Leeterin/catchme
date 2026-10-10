// 두 좌표 사이의 실제 "이동시간"을 구하는 공용 모듈.
// 카카오 대중교통 길찾기 API(REST)를 1순위로 쓰고, 키가 없거나 호출이 실패하거나(쿼터초과 등)
// 커버리지 밖(지하철/버스 노선이 아예 없는 지역이라 status가 OK가 아닌 경우)이면
// 직선거리 ÷ 평균속도로 대략 추정하는 걸로 자동 대체한다(폴백).
// 참고: 카카오맵 대중교통 경로 조회 API - https://developers.kakao.com/docs/ko/kakaomap/rest-api
//   GET https://dapi.kakao.com/v2/routing/publictraffic?start_x=&start_y=&end_x=&end_y=
//   Authorization: KakaoAK {REST_API_KEY}  (카카오 로그인에 이미 쓰는 KAKAO_REST_API_KEY 재사용)
//   응답: routes[].properties.totalTime (초 단위). 여러 경로 후보 중 가장 빠른 걸 씀.
const { distanceKm } = require('./geo');

const KAKAO_TRANSIT_URL = 'https://dapi.kakao.com/v2/routing/publictraffic';
const FALLBACK_SPEED_KMH = 20; // 대중교통 환승/도보 포함 체감 평균속도 - 직선거리 기반 추정이라 다소 보수적으로 잡음
const FALLBACK_MIN_MINUTES = 5;

// 두 좌표 사이 실제 대중교통 이동시간(분)을 구함
// from/to: { lat, lon }
async function getTravelMinutes(from, to) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (key) {
    try {
      const params = new URLSearchParams({
        start_x: String(from.lon),
        start_y: String(from.lat),
        end_x: String(to.lon),
        end_y: String(to.lat),
      });
      const kakaoRes = await fetch(`${KAKAO_TRANSIT_URL}?${params.toString()}`, {
        headers: { Authorization: `KakaoAK ${key}` },
      });
      if (kakaoRes.ok) {
        const data = await kakaoRes.json();
        if (data.status === 'OK' && Array.isArray(data.routes) && data.routes.length > 0) {
          const times = data.routes
            .map((r) => r.properties && r.properties.totalTime)
            .filter((t) => typeof t === 'number' && Number.isFinite(t));
          if (times.length > 0) {
            return { minutes: Math.round(Math.min(...times) / 60), source: 'kakao' };
          }
        }
        // status가 OK가 아니면(노선 없음 등) 아래 폴백으로 넘어감
      } else {
        const text = await kakaoRes.text().catch(() => '');
        console.warn('[transitTime] 카카오 길찾기 API 응답 오류:', kakaoRes.status, text.slice(0, 200));
      }
    } catch (err) {
      console.warn('[transitTime] 카카오 길찾기 API 호출 실패:', err.message);
    }
  }

  const km = distanceKm(from.lat, from.lon, to.lat, to.lon);
  const minutes = Math.max(FALLBACK_MIN_MINUTES, Math.round((km / FALLBACK_SPEED_KMH) * 60));
  return { minutes, source: 'fallback' };
}

// ---------- 일정 이동시간: 자동차 / 대중교통 + 출발 시각 기준 ----------
// 자동차는 카카오모빌리티 길찾기 - 출발 시각이 미래면 "미래 운행 정보"(그 시각 예상 교통량)로, 지금이면 실시간 교통으로 계산.
//   GET https://apis-navi.kakaomobility.com/v1/future/directions?origin=x,y&destination=x,y&departure_time=YYYYMMDDHHmm
//   GET https://apis-navi.kakaomobility.com/v1/directions?origin=x,y&destination=x,y
//   응답: routes[0].result_code === 0 이면 routes[0].summary.duration (초)
// 실패하면 직선거리 ÷ (시간대별 평균속도)로 추정 - 출퇴근 시간은 느리게, 새벽은 빠르게
const KAKAO_NAVI_URL = 'https://apis-navi.kakaomobility.com/v1';
const ROAD_FACTOR = 1.35; // 직선거리 → 실제 도로 거리 대략 비율

// KST 기준 요일(0=일)·시(0~23)·카카오 출발 시각 문자열(YYYYMMDDHHmm)
function kstParts(date) {
  const k = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    dow: k.getUTCDay(),
    hour: k.getUTCHours(),
    stamp: `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}${p(k.getUTCHours())}${p(k.getUTCMinutes())}`,
  };
}
function isNightHour(hour) { return hour >= 0 && hour < 5; }
function isRushHour(dow, hour) { return dow >= 1 && dow <= 5 && ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)); }

function estimateMinutes(from, to, mode, departAt) {
  const { dow, hour } = kstParts(departAt);
  let kmh;
  if (mode === 'car') kmh = isNightHour(hour) ? 45 : isRushHour(dow, hour) ? 18 : 28;
  else kmh = isRushHour(dow, hour) ? 17 : FALLBACK_SPEED_KMH;
  const km = distanceKm(from.lat, from.lon, to.lat, to.lon) * (mode === 'car' ? ROAD_FACTOR : 1);
  return Math.max(FALLBACK_MIN_MINUTES, Math.round((km / kmh) * 60));
}

async function getCarMinutes(from, to, departAt) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (key) {
    try {
      const future = departAt.getTime() > Date.now() + 5 * 60 * 1000;
      const params = new URLSearchParams({ origin: `${from.lon},${from.lat}`, destination: `${to.lon},${to.lat}` });
      if (future) params.set('departure_time', kstParts(departAt).stamp);
      const r = await fetch(`${KAKAO_NAVI_URL}/${future ? 'future/' : ''}directions?${params.toString()}`, {
        headers: { Authorization: `KakaoAK ${key}` },
      });
      if (r.ok) {
        const data = await r.json();
        const route = Array.isArray(data.routes) ? data.routes[0] : null;
        if (route && route.result_code === 0 && route.summary && Number.isFinite(route.summary.duration)) {
          return { minutes: Math.max(1, Math.round(route.summary.duration / 60)), source: 'kakao' };
        }
      } else {
        const text = await r.text().catch(() => '');
        console.warn('[transitTime] 카카오 자동차 길찾기 응답 오류:', r.status, text.slice(0, 200));
      }
    } catch (err) {
      console.warn('[transitTime] 카카오 자동차 길찾기 호출 실패:', err.message);
    }
  }
  return { minutes: estimateMinutes(from, to, 'car', departAt), source: 'fallback' };
}

// 일정 시작(arriveAt)에 맞춰 도착하려면 몇 분 걸리고 언제 출발하는지 - 출발 시각의 교통 상황 기준.
// 자동차는 "30분 전 출발"로 한 번 재고, 그 결과로 정한 출발 시각으로 다시 재서 맞춤
async function getTripMinutes(from, to, mode, arriveAt) {
  const departFor = (m) => new Date(arriveAt.getTime() - m * 60 * 1000);
  let result;
  if (mode === 'car') {
    result = await getCarMinutes(from, to, departFor(30));
    if (Math.abs(result.minutes - 30) > 2) result = await getCarMinutes(from, to, departFor(result.minutes));
  } else {
    result = await getTravelMinutes(from, to);
    // 카카오 대중교통 길찾기는 시각을 안 받아서, 추정치일 때만 출발 시간대 속도로 다시 계산
    if (result.source === 'fallback') result = { minutes: estimateMinutes(from, to, 'transit', departFor(result.minutes)), source: 'fallback' };
  }
  const departAt = departFor(result.minutes);
  // 새벽 대중교통은 지하철·버스가 거의 없어서 화면에 알려줌
  return { ...result, mode, departAt, night: mode === 'transit' && isNightHour(kstParts(departAt).hour) };
}

// 여러 출발지 x 여러 후보지 조합을 한 번에 계산 (동시 호출 수를 제한해서 API 과다호출 방지)
// origins/destinations: { lat, lon } 배열. 반환: minutes[originIdx][destIdx], source는 하나라도 fallback이면 'mixed'
async function getTravelMinutesMatrix(origins, destinations, concurrency = 8) {
  const tasks = [];
  origins.forEach((from, i) => {
    destinations.forEach((to, j) => {
      tasks.push({ i, j, from, to });
    });
  });

  const minutes = origins.map(() => new Array(destinations.length).fill(null));
  let anyFallback = false;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const { i, j, from, to } = tasks[idx];
      const result = await getTravelMinutes(from, to);
      minutes[i][j] = result.minutes;
      if (result.source === 'fallback') anyFallback = true;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length || 1) }, () => worker());
  await Promise.all(workers);

  return { minutes, source: anyFallback ? 'mixed' : 'kakao' };
}

module.exports = { getTravelMinutes, getTravelMinutesMatrix, getTripMinutes };
