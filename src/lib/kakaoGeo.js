// 좌표 -> "동네 이름"(구/동) 변환. 카카오 로컬 API의 좌표->행정구역 변환(coord2regioncode)을 씀.
// 이미 장소 검색(places.controller.js)과 카카오 로그인(auth.controller.js)에서 쓰는 것과 같은
// 카카오 앱의 REST API 키(KAKAO_REST_API_KEY)를 그대로 재사용함.
const KAKAO_REGIONCODE_URL = 'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json';

// 좌표 하나를 "OO구 OO동" 형태의 동네 이름으로 변환. 실패하면 null을 돌려줌(호출부에서 좌표만으로 표시하도록)
async function reverseGeocodeArea(lat, lon) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;

  try {
    const params = new URLSearchParams({ x: String(lon), y: String(lat) });
    const res = await fetch(`${KAKAO_REGIONCODE_URL}?${params.toString()}`, {
      headers: { Authorization: `KakaoAK ${key}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const docs = data.documents || [];
    // region_type 'H'(행정동)을 우선 쓰고, 없으면 'B'(법정동)로 대체
    const doc = docs.find((d) => d.region_type === 'H') || docs[0];
    if (!doc) return null;
    const parts = [doc.region_2depth_name, doc.region_3depth_name].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  } catch (err) {
    console.warn('[kakaoGeo] 좌표->동네 변환 실패:', err.message);
    return null;
  }
}

module.exports = { reverseGeocodeArea };
