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

module.exports = { searchPlaces };
