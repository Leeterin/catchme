// 다중 모임 자동 장소 추천 - 핵심 계산 로직.
// 참가자들의 출발지 좌표를 받아서, 그 주변에 후보 지역 몇 곳을 잡고, 각 후보까지 참가자 전원의
// 실제 이동시간(대중교통)을 구한 다음, 선택한 기준(모드)에 따라 가장 적합한 후보 하나를 고른다.
const { getTravelMinutesMatrix } = require('./transitTime');
const { reverseGeocodeArea } = require('./kakaoGeo');

const GRID_OFFSETS = [-1, 0, 1]; // 참가자들의 좌표 범위(바운딩 박스) 안에서 3x3 격자(총 9개 후보 지점)를 만듦

// 참가자 좌표들을 감싸는 바운딩 박스 중심 주변에 9개의 후보 지점을 만듦.
// 참가자가 2명뿐이면 둘을 잇는 선 위/주변에, 여러 명이면 전체를 감싸는 영역 안쪽에 후보가 생김.
function buildCandidateGrid(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  // 참가자들이 거의 같은 위치면 범위가 0에 가까우니, 최소 step을 보장해서 후보가 한 점에 뭉치지 않게 함
  const latStep = Math.max((maxLat - minLat) / 4, 0.004);
  const lonStep = Math.max((maxLon - minLon) / 4, 0.004);

  const candidates = [];
  GRID_OFFSETS.forEach((dLat) => {
    GRID_OFFSETS.forEach((dLon) => {
      candidates.push({ lat: midLat + dLat * latStep, lon: midLon + dLon * lonStep });
    });
  });
  return candidates;
}

function scoreForMode(timesMinutes, mode) {
  const sum = timesMinutes.reduce((a, b) => a + b, 0);
  const avg = sum / timesMinutes.length;
  const max = Math.max(...timesMinutes);
  const min = Math.min(...timesMinutes);
  if (mode === 'FASTEST') return avg; // 전체 평균 이동시간 최소화
  if (mode === 'CONSIDERATE') return max; // 가장 오래 걸리는 사람 기준 최소화
  return max - min; // FAIR: 참가자 간 이동시간 차이(최댓값-최솟값) 최소화
}

// points: [{ userId, lat, lon }] (최소 2명), mode: 'FAIR' | 'FASTEST' | 'CONSIDERATE'
// 반환: { areaName, lat, lon, avgMinutes, maxMinutes, participantCount } 또는 실패 시 null
async function computeRecommendation(points, mode) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const candidates = buildCandidateGrid(points);
  const { minutes: matrix } = await getTravelMinutesMatrix(points, candidates);
  // matrix[참가자 idx][후보 idx] = 이동시간(분)

  let bestIdx = -1;
  let bestScore = Infinity;
  let bestAvg = 0;
  let bestMax = 0;
  for (let j = 0; j < candidates.length; j++) {
    const timesForCandidate = matrix.map((row) => row[j]);
    const score = scoreForMode(timesForCandidate, mode);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = j;
      const sum = timesForCandidate.reduce((a, b) => a + b, 0);
      bestAvg = sum / timesForCandidate.length;
      bestMax = Math.max(...timesForCandidate);
    }
  }

  if (bestIdx === -1) return null;
  const best = candidates[bestIdx];
  const areaName = (await reverseGeocodeArea(best.lat, best.lon)) || '추천 지역';

  return {
    areaName,
    lat: best.lat,
    lon: best.lon,
    avgMinutes: Math.round(bestAvg),
    maxMinutes: Math.round(bestMax),
    participantCount: points.length,
  };
}

module.exports = { computeRecommendation, buildCandidateGrid, scoreForMode };
