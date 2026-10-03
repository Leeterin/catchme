const prisma = require('../lib/prisma');
// 프론트엔드(브라우저)는 네이버 검색 API를 직접 못 부르기 때문에(CORS + 키 노출 문제),
// 여기서 대신 호출해서 결과만 정리해 돌려준다.
async function searchPlaces(req, res) {
  const { query, sort } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({ message: '검색어(query)가 필요해요.' });
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ message: '서버에 네이버 API 키(NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)가 설정되어 있지 않아요.' });
  }

  const params = new URLSearchParams({
    query,
    display: '10',
    start: '1',
    sort: sort === 'random' ? 'random' : 'comment', // comment = 리뷰(코멘트) 많은 순
  });

  try {
    const naverRes = await fetch(`https://openapi.naver.com/v1/search/local.json?${params.toString()}`, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    if (!naverRes.ok) {
      const text = await naverRes.text();
      console.error('[places] naver api error:', naverRes.status, text);
      return res.status(502).json({ message: '네이버 검색에 실패했어요.' });
    }

    const data = await naverRes.json();
    const places = (data.items || []).map((item) => ({
      name: stripHtml(item.title),
      category: item.category || null,
      address: item.roadAddress || item.address || null,
      phone: item.telephone || null,
      // 네이버 검색 API는 좌표를 10,000,000배 한 정수로 줌 -> 나눠서 보통 위도/경도로 변환
      lat: item.mapy ? Number(item.mapy) / 10000000 : null,
      lon: item.mapx ? Number(item.mapx) / 10000000 : null,
      link: item.link || null,
    }));

    return res.json({ places });
  } catch (err) {
    console.error('[places] search error:', err);
    return res.status(500).json({ message: '검색 중 오류가 발생했어요.' });
  }
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '');
}

// GET /api/places/stats?kakaoIds=1,2,3&ids=uuid,uuid
// 카카오맵 목록 카드 등에 "캐치미 ★4.3 · 리뷰 3 · 약속 5번"을 붙이기 위한 캐치미 자체 집계.
// 결과는 요청한 카카오 id(또는 장소 id)를 키로 돌려줌 - 캐치미에 기록이 없는 곳은 빠짐
async function getPlaceStats(req, res) {
  const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const kakaoIds = split(req.query.kakaoIds);
  const ids = split(req.query.ids);
  if (!kakaoIds.length && !ids.length) return res.json({ stats: {} });

  const places = await prisma.place.findMany({
    where: { OR: [
      ...(kakaoIds.length ? [{ kakaoPlaceId: { in: kakaoIds } }] : []),
      ...(ids.length ? [{ id: { in: ids } }] : []),
    ] },
    select: { id: true, kakaoPlaceId: true },
  });
  if (!places.length) return res.json({ stats: {} });
  const placeIds = places.map((p) => p.id);

  const [events, posts] = await Promise.all([
    prisma.placeEvent.groupBy({ by: ['placeId', 'type'], where: { placeId: { in: placeIds } }, _count: { _all: true } }),
    prisma.feedPost.findMany({
      where: { placeId: { in: placeIds } },
      select: { placeId: true, rating: true, comments: { select: { rating: true } } },
    }),
  ]);

  const stats = {};
  places.forEach((p) => {
    const ratings = [];
    let reviewCount = 0;
    posts.filter((x) => x.placeId === p.id).forEach((x) => {
      reviewCount++;
      if (typeof x.rating === 'number') ratings.push(x.rating);
      x.comments.forEach((c) => { if (typeof c.rating === 'number') ratings.push(c.rating); });
    });
    const count = (type) => (events.find((e) => e.placeId === p.id && e.type === type) || { _count: { _all: 0 } })._count._all;
    const entry = {
      placeId: p.id,
      avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      ratingCount: ratings.length,
      reviewCount,
      confirmCount: count('CONFIRM'),
      suggestCount: count('SUGGEST'),
    };
    if (p.kakaoPlaceId && kakaoIds.includes(p.kakaoPlaceId)) stats[p.kakaoPlaceId] = entry;
    if (ids.includes(p.id)) stats[p.id] = entry;
  });
  return res.json({ stats });
}

module.exports = { searchPlaces, getPlaceStats };
