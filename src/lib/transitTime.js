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

module.exports = { getTravelMinutes, getTravelMinutesMatrix };
