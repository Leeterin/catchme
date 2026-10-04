// 두 좌표 사이의 거리를 km 단위로 계산 (하버사인 공식)
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // 지구 반지름(km)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 다른 사용자와의 거리를 "대략적으로만" 알려줄 때 사용 (정확한 거리를 주면 기준 위치를 바꿔가며 여러 번 물어봐서
// 그 사람 위치를 몇 m 오차로 알아낼 수 있음 - 삼각측량). 상대 좌표를 약 1km 칸(0.01도)의 가운데로 뭉갠 뒤 거리를 재고,
// 0.5km 단위로 반올림, 1km 안쪽은 전부 1로 (화면에선 "1km 이내")
const FUZZ_GRID_DEG = 0.01;
function snapToGrid(deg) {
  return (Math.floor(deg / FUZZ_GRID_DEG) + 0.5) * FUZZ_GRID_DEG;
}
function fuzzyDistanceKm(lat, lon, targetLat, targetLon) {
  const d = distanceKm(lat, lon, snapToGrid(targetLat), snapToGrid(targetLon));
  return Math.max(1, Math.round(d * 2) / 2);
}

// 근처 사람 찾기 반경 상한 - 반경을 크게 줘서 위치 공유 중인 사람 전원을 긁어가지 못하게
const MAX_NEARBY_RADIUS_KM = 10;
function clampNearbyRadius(raw) {
  const r = parseFloat(raw);
  if (!r || r <= 0) return 5;
  return Math.min(r, MAX_NEARBY_RADIUS_KM);
}

module.exports = { distanceKm, fuzzyDistanceKm, clampNearbyRadius };
