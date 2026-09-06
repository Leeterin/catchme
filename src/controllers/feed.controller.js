const prisma = require('../lib/prisma');
const { distanceKm } = require('../lib/geo');

const MAX_IMAGE_CHARS = 700000; // base64 문자열 기준 대략 500KB (프로필 사진과 동일한 기준)
const MAX_PHOTOS = 3;

// 같은 장소(이름/좌표가 거의 같음)가 이미 있으면 그걸 재사용하고, 없으면 새로 만듦.
// - 좌표가 있으면 30m 이내를 "같은 곳"으로 봄 (오타/띄어쓰기 차이를 흡수)
// - 좌표가 없으면 같은 카테고리 안에서 이름이 정확히 같은 곳으로 판단
async function findOrCreatePlace({ name, category, location, lat, lon }) {
  // 두 사람이 완전히 같은 새 장소를 거의 동시에 처음 등록하면, "확인 -> 생성" 사이의 찰나에
  // 둘 다 "아직 없다"고 판단해서 장소가 중복 생성될 수 있음. 이를 막기 위해 같은
  // 이름+카테고리에 대해서는 한 번에 한 요청만 이 로직을 통과하도록 DB 잠금을 걺.
  const lockKey = `${category}::${name.trim().toLowerCase()}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);

    if (typeof lat === 'number' && typeof lon === 'number') {
      const sameCategory = await tx.place.findMany({ where: { category } });
      const nearby = sameCategory.find(
        (p) => typeof p.lat === 'number' && typeof p.lon === 'number' && distanceKm(lat, lon, p.lat, p.lon) < 0.03
      );
      if (nearby) return { place: nearby, wasNew: false };
    }

    const byName = await tx.place.findFirst({
      where: { category, name: { equals: name, mode: 'insensitive' } },
    });
    if (byName) return { place: byName, wasNew: false };

    const created = await tx.place.create({
      data: { name, category, location: location || null, lat: lat ?? null, lon: lon ?? null },
    });
    return { place: created, wasNew: true };
  });
}

// 사진 배열이 올바른지 검사 (개수 제한, base64 이미지 형식, 용량 제한)
function validatePhotos(photos) {
  if (photos === undefined || photos === null) return { valid: [], error: null };
  if (!Array.isArray(photos)) return { valid: null, error: '사진 형식이 올바르지 않아요.' };
  if (photos.length > MAX_PHOTOS) return { valid: null, error: `사진은 최대 ${MAX_PHOTOS}장까지 첨부할 수 있어요.` };
  for (const p of photos) {
    if (typeof p !== 'string' || !p.startsWith('data:image/')) {
      return { valid: null, error: '사진 형식이 올바르지 않아요.' };
    }
    if (p.length > MAX_IMAGE_CHARS) {
      return { valid: null, error: '사진 용량이 너무 커요. 더 작은 사진으로 시도해주세요.' };
    }
  }
  return { valid: photos, error: null };
}

function serializeReview(post, myUserId) {
  const likes = post.likes || [];
  return {
    id: post.id,
    placeId: post.placeId,
    note: post.note,
    rating: post.rating,
    photos: post.photos || [],
    author: post.author ? { id: post.author.id, username: post.author.username, name: post.author.name } : null,
    likeCount: post._count ? post._count.likes : likes.length,
    commentCount: post._count ? post._count.comments : undefined,
    likedByMe: myUserId ? likes.some((l) => l.userId === myUserId) : false,
    createdAt: post.createdAt,
  };
}

function serializeComment(comment) {
  return {
    id: comment.id,
    postId: comment.postId,
    text: comment.text,
    author: comment.author ? { id: comment.author.id, username: comment.author.username, name: comment.author.name } : null,
    createdAt: comment.createdAt,
  };
}

// 광고 노출 기간이 지났으면 자동으로 일반 노출로 취급 (별도 배치작업 없이 조회 시점에 판단)
function isCurrentlySponsored(place) {
  if (!place.isSponsored) return false;
  if (place.sponsoredUntil && new Date(place.sponsoredUntil) <= new Date()) return false;
  return true;
}

function serializePlace(place, refLocation, myUserId) {
  const reviews = place.reviews || [];
  const latest = reviews[0] || null;
  // reviews는 createdAt desc로 오므로, 배열의 마지막 = 이 장소에 가장 먼저 올라온(원조) 리뷰
  const primary = reviews.length > 0 ? reviews[reviews.length - 1] : null;
  const rated = reviews.filter((r) => typeof r.rating === 'number');
  const avgRating = rated.length > 0 ? rated.reduce((sum, r) => sum + r.rating, 0) / rated.length : null;
  const totalLikes = reviews.reduce((sum, r) => sum + (r.likes ? r.likes.length : 0), 0);
  const result = {
    id: place.id,
    name: place.name,
    category: place.category,
    location: place.location,
    lat: place.lat,
    lon: place.lon,
    isSponsored: isCurrentlySponsored(place),
    reviewCount: reviews.length,
    avgRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
    totalLikes,
    latestReview: latest ? serializeReview(latest, myUserId) : null,
    primaryReview: primary ? serializeReview(primary, myUserId) : null,
    createdAt: place.createdAt,
  };
  if (refLocation && typeof place.lat === 'number' && typeof place.lon === 'number') {
    result.distanceKm = distanceKm(refLocation.lat, refLocation.lon, place.lat, place.lon);
  }
  return result;
}

// GET /api/feed?category=food|cafe|experience&lat=&lon=&radiusKm=
// 장소 목록을 반환함 (게시물 하나하나가 아니라, 장소 단위로 묶여서 각 장소의 리뷰 개수/평균 별점/최신 리뷰가 함께 옴).
// 광고(스폰서) 노출 중인 곳이 항상 맨 위. 위치가 주어지면 그다음 거리순, 아니면 최근 리뷰순.
// GET /api/feed?category=&lat=&lon=&radiusKm=&q=&sort=recent|popular|rating
async function listFeedPosts(req, res) {
  const { category, q, sort } = req.query;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const hasLocation = !Number.isNaN(lat) && !Number.isNaN(lon);
  const radiusKm = parseFloat(req.query.radiusKm) || 5;

  const where = { ...(category ? { category } : {}) };
  if (q && q.trim()) {
    where.OR = [
      { name: { contains: q.trim(), mode: 'insensitive' } },
      { location: { contains: q.trim(), mode: 'insensitive' } },
    ];
  }

  const places = await prisma.place.findMany({
    where,
    include: {
      reviews: {
        include: {
          author: { select: { id: true, username: true, name: true } },
          likes: { select: { userId: true } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  let result = places.map((p) => serializePlace(p, hasLocation ? { lat, lon } : null, req.userId));

  if (hasLocation) {
    // 좌표가 없는 장소(직접 입력만 하고 검색으로 안 고른 경우)는 반경 필터링 대상에서 제외됨
    result = result.filter((p) => typeof p.distanceKm === 'number' && p.distanceKm <= radiusKm);
  }

  result.sort((a, b) => {
    if (a.isSponsored !== b.isSponsored) return a.isSponsored ? -1 : 1;
    if (sort === 'popular') return b.totalLikes - a.totalLikes;
    if (sort === 'rating') return (b.avgRating || 0) - (a.avgRating || 0);
    if (hasLocation && sort !== 'recent') return a.distanceKm - b.distanceKm;
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
    include: {
      author: { select: { id: true, username: true, name: true } },
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const rated = reviews.filter((r) => typeof r.rating === 'number');
  const avgRating = rated.length > 0 ? rated.reduce((sum, r) => sum + r.rating, 0) / rated.length : null;

  return res.json({
    place: {
      id: place.id,
      name: place.name,
      category: place.category,
      location: place.location,
      lat: place.lat,
      lon: place.lon,
      isSponsored: isCurrentlySponsored(place),
      avgRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
      reviewCount: reviews.length,
    },
    reviews: reviews.map((r) => serializeReview(r, req.userId)),
  });
}

// POST /api/feed   body: { category, place, note?, rating?, photos?, location?, lat?, lon? }
// 같은 장소가 이미 있으면 그 장소에 리뷰만 추가되고, 없으면 장소가 새로 생기면서 첫 리뷰가 달림.
async function createFeedPost(req, res) {
  const { category, place, note, rating, photos, location, lat, lon } = req.body;
  if (!category || !category.trim()) {
    return res.status(400).json({ message: '카테고리를 선택해주세요.' });
  }
  if (!place || !place.trim()) {
    return res.status(400).json({ message: '장소 이름을 입력해주세요.' });
  }
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ message: '별점은 1~5 사이의 정수여야 해요.' });
    }
  }
  const { valid: validPhotos, error: photoError } = validatePhotos(photos);
  if (photoError) return res.status(400).json({ message: photoError });

  const { place: placeRow, wasNew } = await findOrCreatePlace({
    name: place.trim(),
    category: category.trim(),
    location: location || null,
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
  });

  const post = await prisma.feedPost.create({
    data: {
      authorId: req.userId,
      placeId: placeRow.id,
      note: note || null,
      rating: typeof rating === 'number' ? rating : null,
      photos: validPhotos || [],
    },
    include: { author: { select: { id: true, username: true, name: true } }, likes: true },
  });

  return res.status(201).json({
    post: serializeReview(post, req.userId),
    place: { id: placeRow.id, name: placeRow.name, category: placeRow.category, location: placeRow.location, lat: placeRow.lat, lon: placeRow.lon },
    placeCreated: wasNew,
  });
}

// PATCH /api/feed/:id   body: { note?, rating?, photos? }  - 작성자 본인만 수정 가능. 장소 정보(이름/위치)는
// 여러 사람이 공유하는 값이라 리뷰 수정으로는 못 바꾸고, 내 리뷰 내용(글/별점/사진)만 바꿀 수 있음
async function updateFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '리뷰를 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 수정할 수 있어요.' });
  }

  const { note, rating, photos } = req.body;
  const data = {};
  if (typeof note === 'string') data.note = note || null;
  if (rating !== undefined) {
    if (rating !== null && (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating))) {
      return res.status(400).json({ message: '별점은 1~5 사이의 정수여야 해요.' });
    }
    data.rating = rating;
  }
  if (photos !== undefined) {
    const { valid: validPhotos, error: photoError } = validatePhotos(photos);
    if (photoError) return res.status(400).json({ message: photoError });
    data.photos = validPhotos || [];
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }

  const updated = await prisma.feedPost.update({
    where: { id },
    data,
    include: { author: { select: { id: true, username: true, name: true } }, likes: true },
  });
  return res.json({ post: serializeReview(updated, req.userId) });
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

// POST /api/feed/:id/like  - 좋아요 토글 (이미 눌렀으면 취소, 안 눌렀으면 추가)
async function toggleLike(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '리뷰를 찾을 수 없어요.' });

  const existing = await prisma.feedPostLike.findUnique({
    where: { postId_userId: { postId: id, userId: req.userId } },
  });

  if (existing) {
    await prisma.feedPostLike.delete({ where: { id: existing.id } });
  } else {
    try {
      await prisma.feedPostLike.create({ data: { postId: id, userId: req.userId } });
    } catch (err) {
      if (err.code !== 'P2002') throw err; // 이미 눌렀는데 거의 동시에 또 눌린 경우 - 조용히 무시
    }
  }

  const likeCount = await prisma.feedPostLike.count({ where: { postId: id } });
  return res.json({ liked: !existing, likeCount });
}

// GET /api/feed/:id/comments  - 한 리뷰의 댓글 목록
async function listComments(req, res) {
  const { id } = req.params;
  const comments = await prisma.feedPostComment.findMany({
    where: { postId: id },
    include: { author: { select: { id: true, username: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({ comments: comments.map(serializeComment) });
}

// POST /api/feed/:id/comments   body: { text }
async function createComment(req, res) {
  const { id } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ message: '댓글 내용을 입력해주세요.' });
  }
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '리뷰를 찾을 수 없어요.' });

  const comment = await prisma.feedPostComment.create({
    data: { postId: id, authorId: req.userId, text: text.trim() },
    include: { author: { select: { id: true, username: true, name: true } } },
  });
  return res.status(201).json({ comment: serializeComment(comment) });
}

// DELETE /api/feed/comments/:commentId  - 작성자 본인만 삭제 가능
async function deleteComment(req, res) {
  const { commentId } = req.params;
  const comment = await prisma.feedPostComment.findUnique({ where: { id: commentId } });
  if (!comment) return res.status(404).json({ message: '댓글을 찾을 수 없어요.' });
  if (comment.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 삭제할 수 있어요.' });
  }
  await prisma.feedPostComment.delete({ where: { id: commentId } });
  return res.json({ message: '댓글을 삭제했어요.' });
}

module.exports = {
  listFeedPosts, getPlaceDetail, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, listComments, createComment, deleteComment,
};
