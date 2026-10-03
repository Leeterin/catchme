// 캐치미 자체 장소 DB(Place) 공용 함수
// - 사용자가 실제로 제안/확정/리뷰한 가게만 등록 (카카오 장소 정보를 대량으로 쌓지 않음)
// - 같은 가게 판별: 카카오 장소 id가 같거나, 이름(공백/기호 무시)이 같고 100m 안이면 같은 곳
const { distanceKm } = require('./geo');

const SAME_PLACE_KM = 0.1;
const PLACE_CATEGORIES = ['food', 'cafe', 'experience', 'etc'];

function normalizePlaceName(name) {
  return String(name || '').toLowerCase().replace(/[\s·.,()[\]\-_'"!]/g, '');
}

// 지도에서 아무 곳이나 찍어서 생긴 "주소"나 "선택한 위치"는 가게가 아니므로 장소로 등록하지 않음
const REGION_PREFIX = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청|전북|전남|전라|경북|경남|경상|제주)/;
function isAddressLikeName(name) {
  const n = String(name || '').trim();
  if (!n || n === '선택한 위치' || n === '내 위치') return true;
  return REGION_PREFIX.test(n) && /\d+(-\d+)?$/.test(n);
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max || 200) : null;
}

// info: { name, lat, lon, address?, phone?, category?, categoryDetail?, location?, kakaoPlaceId? }
// 좌표가 없으면(직접 타이핑한 "집 앞" 같은 것) 다른 곳과 섞일 수 있어서 등록하지 않고 null을 돌려줌
async function findOrCreatePlace(db, info) {
  const name = cleanStr(info && info.name, 100);
  const lat = typeof info.lat === 'number' && Number.isFinite(info.lat) ? info.lat : null;
  const lon = typeof info.lon === 'number' && Number.isFinite(info.lon) ? info.lon : null;
  if (!name || lat === null || lon === null || isAddressLikeName(name)) return null;
  const kakaoPlaceId = cleanStr(info.kakaoPlaceId != null ? String(info.kakaoPlaceId) : null, 40);
  const normName = normalizePlaceName(name);
  const category = PLACE_CATEGORIES.includes(info.category) ? info.category : null;
  const extra = {
    address: cleanStr(info.address),
    phone: cleanStr(info.phone, 40),
    categoryDetail: cleanStr(info.categoryDetail, 100),
    location: cleanStr(info.location),
  };

  let place = kakaoPlaceId ? await db.place.findUnique({ where: { kakaoPlaceId } }) : null;
  if (!place) {
    const sameName = await db.place.findMany({ where: { normName }, take: 50 });
    place = sameName.find((p) => typeof p.lat === 'number' && typeof p.lon === 'number'
      && distanceKm(lat, lon, p.lat, p.lon) <= SAME_PLACE_KM) || null;
  }

  if (place) {
    // 비어있던 정보만 채움 (이미 있는 값은 덮어쓰지 않음)
    const fill = {};
    if (kakaoPlaceId && !place.kakaoPlaceId) fill.kakaoPlaceId = kakaoPlaceId;
    Object.entries(extra).forEach(([k, v]) => { if (v && !place[k]) fill[k] = v; });
    if (category && (place.category === 'etc' || !place.category)) fill.category = category;
    if (Object.keys(fill).length) {
      try {
        place = await db.place.update({ where: { id: place.id }, data: fill });
      } catch (err) {
        // kakaoPlaceId가 다른 행에 이미 있는 드문 경우 - 연결은 그대로 쓰고 채우기만 건너뜀
        console.error('[places] fill failed:', err.message);
      }
    }
    return place;
  }

  try {
    return await db.place.create({
      data: {
        name, normName, lat, lon,
        category: category || 'etc',
        kakaoPlaceId,
        source: kakaoPlaceId ? 'kakao' : 'user',
        ...extra,
      },
    });
  } catch (err) {
    // 동시에 같은 카카오 장소가 등록된 경우 그걸 씀
    if (kakaoPlaceId) {
      const existing = await db.place.findUnique({ where: { kakaoPlaceId } });
      if (existing) return existing;
    }
    throw err;
  }
}

// 장소 등록/기록이 실패해도 원래 동작(제안/확정/리뷰)은 막지 않음
async function safeFindOrCreatePlace(db, info) {
  try {
    return await findOrCreatePlace(db, info);
  } catch (err) {
    console.error('[places] findOrCreate failed:', err.message);
    return null;
  }
}

async function recordPlaceEvent(db, { placeId, type, userId, chatRoomId, messageId, postId }) {
  if (!placeId) return;
  try {
    await db.placeEvent.create({
      data: {
        placeId, type,
        userId: userId || null,
        chatRoomId: chatRoomId || null,
        messageId: messageId || null,
        postId: postId || null,
      },
    });
  } catch (err) {
    console.error('[places] event failed:', err.message);
  }
}

module.exports = { isAddressLikeName, normalizePlaceName, findOrCreatePlace, safeFindOrCreatePlace, recordPlaceEvent, PLACE_CATEGORIES };
