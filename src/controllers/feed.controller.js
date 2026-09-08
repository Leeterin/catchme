const prisma = require('../lib/prisma');
const { distanceKm } = require('../lib/geo');

const MAX_IMAGE_CHARS = 700000; // base64 문자열 기준 대략 500KB (프로필 사진과 동일한 기준)
const MAX_PHOTOS = 3;

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

// 게시물 하나를 통째로 반환 (제목/위치/카테고리 등 전부 게시물 자체에 있음 - 더 이상 장소로 안 묶음).
// 예전 방식(장소 분리 시절)으로 만들어진 게시물은 title/category/location이 비어있을 수 있어서,
// 그 경우엔 연결된 place에서 값을 가져와 보여줌 (과거 데이터도 안 깨지게).
function serializePost(post, myUserId) {
  const likes = post.likes || [];
  return {
    id: post.id,
    author: post.author ? { id: post.author.id, username: post.author.username, name: post.author.name } : null,
    category: post.category || (post.place ? post.place.category : null),
    title: post.title || (post.place ? post.place.name : ''),
    location: post.location || (post.place ? post.place.location : null),
    lat: post.lat ?? (post.place ? post.place.lat : null),
    lon: post.lon ?? (post.place ? post.place.lon : null),
    note: post.note,
    rating: post.rating,
    photos: post.photos || [],
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

  const posts = await prisma.feedPost.findMany({
    where,
    include: {
      author: { select: { id: true, username: true, name: true } },
      place: true,
      likes: { select: { userId: true } },
      _count: { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  let result = posts.map((p) => serializePost(p, req.userId));

  if (hasLocation) {
    // 위치가 없는 게시물(직접 입력만 하고 검색으로 안 고른 경우)은 반경 필터링 대상에서 제외됨
    result = result
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number')
      .map((p) => ({ ...p, distanceKm: distanceKm(lat, lon, p.lat, p.lon) }))
      .filter((p) => p.distanceKm <= radiusKm);
  }

  result.sort((a, b) => {
    if (sort === 'popular') return b.likeCount - a.likeCount;
    if (sort === 'rating') return (b.rating || 0) - (a.rating || 0);
    if (hasLocation && sort !== 'recent') return a.distanceKm - b.distanceKm;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return res.json({ posts: result });
}

// POST /api/feed   body: { category, title, note?, rating?, photos?, location?, lat?, lon? }
// 게시물을 독립적으로 하나 만듦 (다른 사람 글과 안 묶임)
async function createFeedPost(req, res) {
  const { category, title, note, rating, photos, location, lat, lon } = req.body;
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
  const { valid: validPhotos, error: photoError } = validatePhotos(photos);
  if (photoError) return res.status(400).json({ message: photoError });

  const post = await prisma.feedPost.create({
    data: {
      authorId: req.userId,
      category: category.trim(),
      title: title.trim(),
      location: location || null,
      lat: typeof lat === 'number' ? lat : null,
      lon: typeof lon === 'number' ? lon : null,
      note: note || null,
      rating: typeof rating === 'number' ? rating : null,
      photos: validPhotos || [],
    },
    include: { author: { select: { id: true, username: true, name: true } }, likes: true },
  });

  return res.status(201).json({ post: serializePost(post, req.userId) });
}

// PATCH /api/feed/:id   body: { title?, note?, rating?, photos?, location? }  - 작성자 본인만 수정 가능
async function updateFeedPost(req, res) {
  const { id } = req.params;
  const post = await prisma.feedPost.findUnique({ where: { id } });
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });
  if (post.authorId !== req.userId) {
    return res.status(403).json({ message: '작성자만 수정할 수 있어요.' });
  }

  const { title, note, rating, photos, location } = req.body;
  const data = {};
  if (typeof title === 'string') {
    if (!title.trim()) return res.status(400).json({ message: '제목을 입력해주세요.' });
    data.title = title.trim();
  }
  if (typeof note === 'string') data.note = note || null;
  if (typeof location === 'string') data.location = location || null;
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
  return res.json({ post: serializePost(updated, req.userId) });
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
  if (!post) return res.status(404).json({ message: '게시물을 찾을 수 없어요.' });

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
  listFeedPosts, createFeedPost, updateFeedPost, deleteFeedPost,
  toggleLike, listComments, createComment, deleteComment,
};
