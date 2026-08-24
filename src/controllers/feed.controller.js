const prisma = require('../lib/prisma');
const { distanceKm } = require('../lib/geo');

// 같은 장소(이름/좌표가 거의 같음)가 이미 있으면 그걸 재사용하고, 없으면 새로 만듦.
// - 좌표가 있으면 30m 이내를 "같은 곳"으로 봄 (오타/띄어쓰기 차이를 흡수)
// - 좌표가 없으면 같은 카테고리 안에서 이름이 정확히 같은 곳으로 판단
async function findOrCreatePlace({ name, category, location, lat, lon }) {
  if (typeof lat === 'number' && typeof lon === 'number') {
    const sameCategory = await prisma.place.findMany({ where: { category } });
    const nearby = sameCategory.find(
      (p) => typeof p.lat === 'number' && typeof p.lon === 'number' && distanceKm(lat, lon, p.lat, p.lon) < 0.03
    );
    if (nearby) return { place: nearby, wasNew: false };
  }

  const byName = await prisma.place.findFirst({
    where: { category, name: { equals: name, mode: 'insensitive' } },
  });
  if (byName) return { place: byName, wasNew: false };

  const created = await prisma.place.create({
    data: { name, category, location: location || null, lat: lat ?? null, lon: lon ?? null },
  });
  return { place: created, wasNew: true };
}

function serializeReview(post) {
  return {
    id: post.id,
    placeId: post.placeId,
    note: post.note,
    author: post.author ? { id: post.author.id, username: post.author.username, name: post.author.name } : null,
    createdAt: post.createdAt,
  };
}

// 광고 노출 기간이 지났으면 자동으로 일반 노출로 취급 (별도 배치작업 없이 조회 시점에 판단)
function isCurrentlySponsored(place) {
  if (!place.isSponsored) return false;
  if (place.sponsoredUntil && new Date(place.sponsoredUntil) <= new Date()) return false;
  return true;
}

function serializePlace(place, refLocation) {
  const reviews = place.reviews || [];
  const latest = reviews[0] || null;
  const result = {
    id: place.id,
    name: place.name,
    category: place.category,
    location: place.location,
    lat: place.lat,
    lon: place.lon,
    isSponsored: isCurrentlySponsored(place),
    reviewCount: reviews.length,
    latestReview: latest ? serializeReview(latest) : null,
    createdAt: place.createdAt,
  };
  if (refLocation && typeof place.lat === 'number' && typeof place.lon === 'number') {
    result.distanceKm = distanceKm(refLocation.lat, refLocation.lon, place.lat, place.lon);
  }
  return result;
}

// GET /api/feed?category=food|cafe|experience&lat=&lon=&radiusKm=
// 장소 목록을 반환함 (게시물 하나하나가 아니라, 장소 단위로 묶여서 각 장소의 리뷰 개수/최신 리뷰가 함께 옴).
// 광고(스폰서) 노출 중인 곳이 항상 맨 위. 위치가 주어지면 그다음 거리순, 아니면 최근 리뷰순.
async function listFeedPosts(req, res) {
  const { category } = req.query;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const hasLocation = !Number.isNaN(lat) && !Number.isNaN(lon);
  const radiusKm = parseFloat(req.query.radiusKm) || 5;

  const places = await prisma.place.findMany({
    where: category ? { category } : undefined,
    include: {
      reviews: {
        include: { author: { select: { id: true, username: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  let result = places.map((p) => serializePlace(p, hasLocation ? { lat, lon } : null));

  if (hasLocation) {
    // 좌표가 없는 장소(직접 입력만 하고 검색으로 안 고른 경우)는 반경 필터링 대상에서 제외됨
    result = result.filter((p) => typeof p.distanceKm === 'number' && p.distanceKm <= radiusKm);
  }

  result.sort((a, b) => {
    if (a.isSponsored !== b.isSponsored) return a.isSponsored ? -1 : 1;
    if (hasLocation) return a.distanceKm - b.distanceKm;
    const aTime = new Date(a.latestReview ? a.latestReview.createdAt : a.createdAt);
    const bTime = new Date(b.latestReview ? b.latestReview.createdAt : b.createdAt);
    return bTime - aTime;
  });

  return res.json({ places: result });
}

// GET /api/feed/places/:placeId  - 한 장소의 전체 리뷰 목록 (장소 카드를 눌러서 상세로 들어갔을 때)
async function getPlaceDetail(req, res) {
  const { placeId } = req.params;
  const place = await prisma.place.findUnique({ where: { id: placeId } });
  if (!place) return res.status(404).json({ message: '장소를 찾을 수 없어요.' });

  const reviews = await prisma.feedPost.findMany({
    where: { placeId },
    include: { author: { select: { id: true, username: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    place: {
      id: place.id,
      name: place.name,
      category: place.category,
      location: place.location,
      lat: place.lat,
      lon: place.lon,
      isSponsored: isCurrentlySponsored(place),
    },
    reviews: reviews.map(serializeReview),
  });
}

// POST /api/feed   body: { category, place, note?, location?, lat?, lon? }
// 같은 장소가 이미 있으면 그 장소에 리뷰만 추가되고, 없으면 장소가 새로 생기면서 첫 리뷰가 달림.
async function createFeedPost(req, res) {
  const { category, place, note, location, lat, lon } = req.body;
  if (!category || !category.trim()) {
    return res.status(400).json({ message: '카테고리를 선택해주세요.' });
  }
  if (!place || !place.trim()) {
    return res.status(400).json({ message: '장소 이름을 입력해주세요.' });
  }

  const { place: placeRow, wasNew } = await findOrCreatePlace({
    name: place.trim(),
    category: category.trim(),
    location: location || null,
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
  });

  const post = await prisma.feedPost.create({
    data: { authorId: req.userId, placeId: placeRow.id, note: note || null },
    include: { author: { select: { id: true, username: true, name: true } } },
  });

  return res.status(201).json({
    post: serializeReview(post),
    place: { id: placeRow.id, name: placeRow.name, category: placeRow.category, location: placeRow.location, lat: placeRow.lat, lon: placeRow.lon },
    placeCreated: wasNew,
  });
}

// PATCH /api/feed/:id   body: { note }  - 작성자 본인만 수정 가능. 장소 정보(이름/위치)는 여러 사람이 공유하는
// 값이라 리뷰 수정으로는 못 바꾸고, 내 리뷰 문구만 바꿀 수 있음
async function updateFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '리뷰를 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 수정할 수 있어요.' });
  }

  const { note } = req.body;
  if (typeof note !== 'string') {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }

  const updated = await prisma.feedPost.update({
    where: { id },
    data: { note: note || null },
    include: { author: { select: { id: true, username: true, name: true } } },
  });
  return res.json({ post: serializeReview(updated) });
}

// DELETE /api/feed/:id  - 작성자 본인만 삭제 가능 (장소 자체는 다른 사람 리뷰가 있으면 계속 남아있음)
async function deleteFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '리뷰를 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 삭제할 수 있어요.' });
  }
  await prisma.feedPost.delete({ where: { id } });
  return res.json({ message: '리뷰를 삭제했어요.' });
}

module.exports = { listFeedPosts, getPlaceDetail, createFeedPost, updateFeedPost, deleteFeedPost };
