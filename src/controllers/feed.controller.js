const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { safeFindOrCreatePlace, recordPlaceEvent } = require('../lib/places');
const { distanceKm } = require('../lib/geo');
const { isAllowedImageDataUrl } = require('../lib/validators');
const { attachAvatarFlags } = require('../lib/avatarFlags');

const MAX_IMAGE_CHARS = 700000; // base64 문자열 기준 대략 500KB (프로필 사진과 동일한 기준)
const MAX_PHOTOS = 5;
const MIN_PHOTOS = 1;

// 사진 배열이 올바른지 검사 (개수 제한, base64 이미지 형식, 용량 제한)
// requireAtLeastOne이 true면 사진이 최소 1장은 있어야 함 - 지금은 사진 없이도 게시물을 올릴 수 있어서 항상 false로 씀 (호출부 참고)
function validatePhotos(photos, { requireAtLeastOne } = {}) {
  if (photos === undefined || photos === null) {
    if (requireAtLeastOne) return { valid: null, error: `사진을 최소 ${MIN_PHOTOS}장 올려주세요.` };
    return { valid: [], error: null };
  }
  if (!Array.isArray(photos)) return { valid: null, error: '사진 형식이 올바르지 않아요.' };
  if (requireAtLeastOne && photos.length < MIN_PHOTOS) return { valid: null, error: `사진을 최소 ${MIN_PHOTOS}장 올려주세요.` };
  if (photos.length > MAX_PHOTOS) return { valid: null, error: `사진은 최대 ${MAX_PHOTOS}장까지 첨부할 수 있어요.` };
  for (const p of photos) {
    if (!isAllowedImageDataUrl(p)) {
      return { valid: null, error: '사진 형식이 올바르지 않아요. (png/jpg/webp/gif만 가능)' };
    }
    if (p.length > MAX_IMAGE_CHARS) {
      return { valid: null, error: '사진 용량이 너무 커요. 더 작은 사진으로 시도해주세요.' };
    }
  }
  return { valid: photos, error: null };
}

// 작성자 정보를 응답에 넣을 때 공용으로 쓰는 모양 - 프로필 사진 원본(base64)은 안 보내고
// 있는지 여부만 보내서, 프론트에서 친구/채팅 목록과 똑같이 /api/users/:id/avatar 로 따로 받아 쓰게 함
// reviewNickname/hasReviewAvatar: 실명이 창피할 수 있어서 만든 "리뷰용 프로필" - 소식/커뮤니티 화면에서만
// 쓰이고, 친구 목록/채팅/모임 같은 다른 화면은 원래 실명 프로필을 그대로 씀. 설정 안 했으면 null/false로
// 내려가고, 그러면 프론트에서 실명/기존 프로필 사진으로 자동 대체됨.
function serializeAuthor(author) {
  if (!author) return null;
  return {
    id: author.id,
    username: author.username,
    name: author.name,
    hasAvatar: author.hasAvatar ?? !!author.profileImageUrl,
    reviewNickname: author.reviewNickname || null,
    hasReviewAvatar: author.hasReviewAvatar ?? !!author.reviewAvatarUrl,
  };
}

// 게시물 하나를 통째로 반환 (제목/위치/카테고리 등 전부 게시물 자체에 있음 - 더 이상 장소로 안 묶음).
// 예전 방식(장소 분리 시절)으로 만들어진 게시물은 title/category/location이 비어있을 수 있어서,
// 그 경우엔 연결된 place에서 값을 가져와 보여줌 (과거 데이터도 안 깨지게).
// 사진 원본(base64)을 목록 응답에 통째로 넣으면 리뷰가 쌓일수록 소식 탭이 점점 무거워져서,
// 목록에는 사진 주소(GET /api/feed-photos/:postId/:idx)만 넣고 실제 사진은 브라우저가 따로 받아 캐싱하게 함.
// ?v=는 사진 내용 해시 - 사진을 바꾸면 주소도 바뀌어서 예전 캐시가 안 보이게 됨
function apiOrigin(req) {
  if (process.env.PUBLIC_API_ORIGIN) return process.env.PUBLIC_API_ORIGIN.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
function photoUrls(req, postId, photos) {
  if (!req) return photos;
  return photoUrlsFromHashes(req, postId, photos.map((p) => crypto.createHash('md5').update(p).digest('hex').slice(0, 10)));
}
// 해시를 DB에서 미리 계산해온 경우(목록) - 사진 원본을 서버로 안 가져와도 똑같은 주소가 나옴
function photoUrlsFromHashes(req, postId, hashes) {
  const origin = apiOrigin(req);
  return hashes.map((v, i) => `${origin}/api/feed-photos/${postId}/${i}?v=${v}`);
}
// 수정할 때 프론트가 기존 사진을 위 주소 그대로 돌려보내면, 이 게시물에 저장돼 있던 원본으로 되바꿔줌
function resolvePhotoRefs(postId, existingPhotos, photos) {
  if (!Array.isArray(photos)) return photos;
  const re = new RegExp(`/api/feed-photos/${postId}/(\\d+)(?:\\?|$)`);
  return photos.map((p) => {
    const m = typeof p === 'string' ? p.match(re) : null;
    return m && existingPhotos[Number(m[1])] ? existingPhotos[Number(m[1])] : p;
  });
}

// GET /api/feed-photos/:postId/:idx - 로그인 없이 열어둠 (<img> 태그는 인증 헤더를 못 보내서). 아바타와 같은 방식
async function getFeedPhoto(req, res) {
  const { serveBase64Image } = require('./avatar.controller');
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PHOTOS) return res.status(404).end();
  // 게시물 사진 전체(최대 5장) 대신 필요한 한 장만 DB에서 꺼냄 (Postgres 배열은 1부터 셈)
  const rows = await prisma.$queryRaw`SELECT photos[${idx + 1}::int] AS photo FROM feed_posts WHERE id = ${req.params.postId}`;
  return serveBase64Image(rows[0] ? rows[0].photo : null, res);
}

function serializePost(post, myUserId, req) {
  const likes = post.likes || [];
  // 게시물 자신의 별점(작성자가 처음 남긴 것)과, 리뷰(댓글)에 달린 별점들을 다 합쳐서 평균을 냄.
  // 네이버지도처럼 "4.3 ★★★★☆ (12)" 형태로 보여주기 위한 값.
  const commentRatings = (post.comments || []).map((c) => c.rating).filter((r) => typeof r === 'number');
  const allRatings = typeof post.rating === 'number' ? [post.rating, ...commentRatings] : commentRatings;
  const avgRating = allRatings.length > 0 ? allRatings.reduce((sum, r) => sum + r, 0) / allRatings.length : null;
  return {
    id: post.id,
    placeId: post.placeId || null,
    author: serializeAuthor(post.author),
    category: post.category || (post.place ? post.place.category : null),
    title: post.title || (post.place ? post.place.name : ''),
    location: post.location || (post.place ? post.place.location : null),
    address: post.address || null,
    phone: post.phone || null,
    lat: post.lat ?? (post.place ? post.place.lat : null),
    lon: post.lon ?? (post.place ? post.place.lon : null),
    note: post.note,
    rating: post.rating,
    avgRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
    ratingCount: allRatings.length,
    photos: post.photoHashes ? photoUrlsFromHashes(req, post.id, post.photoHashes) : photoUrls(req, post.id, post.photos || []),
    tags: post.tags || [],
    fromMeetup: !!post.fromMeetup,
    likeCount: post._count ? post._count.likes : likes.length,
    commentCount: post._count ? post._count.comments : (post.comments ? post.comments.length : undefined),
    likedByMe: myUserId ? likes.some((l) => l.userId === myUserId) : false,
    createdAt: post.createdAt,
  };
}

// 약속 후 후기에서 고를 수 있는 항목 (이외의 값은 버림)
const REVIEW_TAGS = ['talk', 'group', 'price', 'revisit'];
function parseTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t) => REVIEW_TAGS.includes(t)))];
}

function serializeComment(comment) {
  return {
    id: comment.id,
    postId: comment.postId,
    text: comment.text,
    rating: comment.rating,
    author: serializeAuthor(comment.author),
    createdAt: comment.createdAt,
  };
}

const FEED_POST_FIELDS_WITHOUT_PHOTOS = Object.fromEntries(
  Object.keys(Prisma.FeedPostScalarFieldEnum).filter((k) => k !== 'photos').map((k) => [k, true])
);

// 게시물들에 사진 해시(photoHashes)와 작성자 프로필 사진 유무(hasAvatar/hasReviewAvatar)를 붙임 - 원본은 DB 밖으로 안 꺼냄
async function attachMediaInfo(posts) {
  if (posts.length === 0) return;
  const postIds = posts.map((p) => p.id);
  const authorIds = [...new Set(posts.map((p) => p.authorId))];
  const [photoRows, authorRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT id, ARRAY(SELECT substr(md5(p), 1, 10) FROM unnest(photos) WITH ORDINALITY AS t(p, o) ORDER BY o) AS "hashes"
      FROM feed_posts WHERE id = ANY(${postIds})`,
    prisma.$queryRaw`
      SELECT id, "profileImageUrl" IS NOT NULL AS "hasAvatar", "reviewAvatarUrl" IS NOT NULL AS "hasReviewAvatar"
      FROM users WHERE id = ANY(${authorIds})`,
  ]);
  const hashesById = new Map(photoRows.map((r) => [r.id, r.hashes || []]));
  const authorById = new Map(authorRows.map((r) => [r.id, r]));
  for (const p of posts) {
    p.photoHashes = hashesById.get(p.id) || [];
    const a = authorById.get(p.authorId);
    if (p.author && a) {
      p.author.hasAvatar = a.hasAvatar;
      p.author.hasReviewAvatar = a.hasReviewAvatar;
    }
  }
}

// GET /api/feed?category=&lat=&lon=&radiusKm=&q=&sort=recent|popular|rating
// 게시물을 하나하나 독립적으로 반환함 (더 이상 장소 단위로 묶지 않음 - 같은 가게라도 쓴 사람마다 각자 카드로 뜸).
async function listFeedPosts(req, res) {
  const { category, q, sort } = req.query;
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const hasLocation = !Number.isNaN(lat) && !Number.isNaN(lon);
  const radiusKm = parseFloat(req.query.radiusKm) || 5;

  const where = { ...(category ? { category } : {}) };
  if (q && q.trim()) {
    where.OR = [
      { title: { contains: q.trim(), mode: 'insensitive' } },
      { location: { contains: q.trim(), mode: 'insensitive' } },
    ];
  }

  // 예전엔 모든 게시물의 사진 원본(최대 5장)과 작성자 프로필 사진 원본까지 서버로 다 읽어왔다가 버렸음 -
  // 글이 쌓이면 서버 메모리가 모자랄 수 있어서, 사진은 빼고 읽고 필요한 값(사진 해시, 프로필 사진 유무)만 DB에서 계산해옴
  let posts = await prisma.feedPost.findMany({
    where,
    select: {
      ...FEED_POST_FIELDS_WITHOUT_PHOTOS,
      author: { select: { id: true, username: true, name: true, reviewNickname: true } },
      place: { select: { name: true, category: true, location: true, lat: true, lon: true } },
      likes: { select: { userId: true } },
      comments: { select: { rating: true } },
      _count: { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (hasLocation) {
    // 위치가 없는 게시물(직접 입력만 하고 검색으로 안 고른 경우)은 반경 필터링 대상에서 제외됨
    posts = posts.filter((p) => {
      const pLat = p.lat ?? (p.place ? p.place.lat : null);
      const pLon = p.lon ?? (p.place ? p.place.lon : null);
      return typeof pLat === 'number' && typeof pLon === 'number' && distanceKm(lat, lon, pLat, pLon) <= radiusKm;
    });
  }

  await attachMediaInfo(posts);
  let result = posts.map((p) => serializePost(p, req.userId, req));
  if (hasLocation) {
    result = result.map((p) => ({ ...p, distanceKm: distanceKm(lat, lon, p.lat, p.lon) }));
  }

  result.sort((a, b) => {
    if (sort === 'popular') return b.likeCount - a.likeCount;
    if (sort === 'rating') return (b.avgRating || 0) - (a.avgRating || 0);
    if (hasLocation && sort !== 'recent') return a.distanceKm - b.distanceKm;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return res.json({ posts: result });
}

// POST /api/feed   body: { category, title, note?, rating?, photos?, location?, address?, phone?, lat?, lon?, tags?, fromMeetup? }
// 게시물을 독립적으로 하나 만듦 (다른 사람 글과 안 묶임)
async function createFeedPost(req, res) {
  const { category, title, note, rating, photos, location, address, phone, lat, lon, tags, fromMeetup, kakaoPlaceId, placeCategoryDetail } = req.body;
  if (!category || !category.trim()) {
    return res.status(400).json({ message: '카테고리를 선택해주세요.' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ message: '제목(장소명)을 입력해주세요.' });
  }
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ message: '별점은 1~5 사이의 정수여야 해요.' });
    }
  }
  const { valid: validPhotos, error: photoError } = validatePhotos(photos, { requireAtLeastOne: false });
  if (photoError) return res.status(400).json({ message: photoError });

  // 캐치미 장소 DB에서 같은 가게를 찾아 이 리뷰를 연결 (이름이 조금 달라도 같은 곳이면 리뷰가 하나로 모임)
  const place = await safeFindOrCreatePlace(prisma, {
    name: title.trim(), lat, lon, address, phone, location, category: category.trim(), kakaoPlaceId, categoryDetail: placeCategoryDetail,
  });

  const post = await prisma.feedPost.create({
    data: {
      authorId: req.userId,
      placeId: place ? place.id : null,
      category: category.trim(),
      title: title.trim(),
      location: location || null,
      address: (typeof address === 'string' && address.trim()) ? address.trim() : null,
      phone: (typeof phone === 'string' && phone.trim()) ? phone.trim() : null,
      lat: typeof lat === 'number' ? lat : null,
      lon: typeof lon === 'number' ? lon : null,
      note: note || null,
      rating: typeof rating === 'number' ? rating : null,
      photos: validPhotos || [],
      tags: parseTags(tags),
      fromMeetup: fromMeetup === true,
    },
    include: { author: { select: { id: true, username: true, name: true, profileImageUrl: true, reviewNickname: true, reviewAvatarUrl: true } }, likes: true },
  });

  await recordPlaceEvent(prisma, { placeId: post.placeId, type: 'REVIEW', userId: req.userId, postId: post.id });
  return res.status(201).json({ post: serializePost(post, req.userId, req) });
}

// PATCH /api/feed/:id   body: { title?, note?, rating?, photos?, location?, address?, phone?, lat?, lon?, tags? }  - 작성자 본인만 수정 가능
async function updateFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 수정할 수 있어요.' });
  }

  const { title, note, rating, photos, location, address, phone, lat, lon, tags } = req.body;
  const data = {};
  if (Array.isArray(tags)) data.tags = parseTags(tags);
  if (typeof title === 'string') {
    if (!title.trim()) return res.status(400).json({ message: '제목을 입력해주세요.' });
    data.title = title.trim();
  }
  if (typeof note === 'string') data.note = note || null;
  if (typeof location === 'string') data.location = location || null;
  // 주소/전화는 수정 폼에서 장소를 다시 검색해서 고르면 같이 갱신됨 (직접 입력 칸은 아님)
  if (typeof address === 'string') data.address = address.trim() || null;
  if (typeof phone === 'string') data.phone = phone.trim() || null;
  if (typeof lat === 'number') data.lat = lat;
  if (typeof lon === 'number') data.lon = lon;
  if (rating !== undefined) {
    if (rating !== null && (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating))) {
      return res.status(400).json({ message: '별점은 1~5 사이의 정수여야 해요.' });
    }
    data.rating = rating;
  }
  if (photos !== undefined) {
    const { valid: validPhotos, error: photoError } = validatePhotos(resolvePhotoRefs(id, post.photos || [], photos), { requireAtLeastOne: false });
    if (photoError) return res.status(400).json({ message: photoError });
    data.photos = validPhotos || [];
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: '변경할 내용이 없어요.' });
  }
  // 장소(이름/좌표)를 바꿨으면 연결된 장소도 다시 찾음
  if (data.title !== undefined || data.lat !== undefined || data.lon !== undefined) {
    const place = await safeFindOrCreatePlace(prisma, {
      name: data.title ?? post.title, lat: data.lat ?? post.lat, lon: data.lon ?? post.lon,
      address: data.address ?? post.address, phone: data.phone ?? post.phone, location: data.location ?? post.location,
      category: post.category,
    });
    if (place && place.id !== post.placeId) data.placeId = place.id;
  }

  const updated = await prisma.feedPost.update({
    where: { id },
    data,
    include: { author: { select: { id: true, username: true, name: true, profileImageUrl: true, reviewNickname: true, reviewAvatarUrl: true } }, likes: true },
  });
  return res.json({ post: serializePost(updated, req.userId, req) });
}

// DELETE /api/feed/:id  - 작성자 본인만 삭제 가능
async function deleteFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 삭제할 수 있어요.' });
  }
  await prisma.feedPost.delete({ where: { id } });
  return res.json({ message: '삭제했어요.' });
}

// POST /api/feed/:id/like  - 좋아요 토글 (이미 눌렀으면 취소, 안 눌렀으면 추가)
async function toggleLike(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });

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

// GET /api/feed/:id/comments  - 한 게시물의 댓글 목록
async function listComments(req, res) {
  const { id } = req.params;
  const comments = await prisma.feedPostComment.findMany({
    where: { postId: id },
    include: { author: { select: { id: true, username: true, name: true, reviewNickname: true } } },
    orderBy: { createdAt: 'asc' },
  });
  await attachAvatarFlags(comments.map((c) => c.author));
  return res.json({ comments: comments.map(serializeComment) });
}

// POST /api/feed/:id/comments   body: { text }
async function createComment(req, res) {
  const { id } = req.params;
  const { text, rating } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ message: '댓글 내용을 입력해주세요.' });
  }
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: '별점은 1~5 사이의 정수여야 해요.' });
    }
  }
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });

  const comment = await prisma.feedPostComment.create({
    data: { postId: id, authorId: req.userId, text: text.trim(), rating: typeof rating === 'number' ? rating : null },
    include: { author: { select: { id: true, username: true, name: true, reviewNickname: true } } },
  });
  await attachAvatarFlags([comment.author]);
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
  getFeedPhoto,
  listFeedPosts, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, listComments, createComment, deleteComment,
};
