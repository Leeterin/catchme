// 1회용: 장소 DB(places)를 만들기 전에 쌓인 리뷰/장소 제안/장소 알림을 장소에 연결하고 행동 기록을 채움
// 여러 번 실행해도 안전함 (이미 연결된 건 건너뜀)
// 실행: node scripts/backfill-places.js        (미리보기: --dry)
require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { findOrCreatePlace } = require('../src/lib/places');

const DRY = process.argv.includes('--dry');

async function main() {
  const summary = { reviews: 0, suggests: 0, notices: 0, events: 0, skippedNoCoords: 0 };

  const posts = await prisma.feedPost.findMany({ where: { placeId: null } });
  for (const post of posts) {
    if (typeof post.lat !== 'number' || typeof post.lon !== 'number' || !post.title) { summary.skippedNoCoords++; continue; }
    if (DRY) { summary.reviews++; continue; }
    const place = await findOrCreatePlace(prisma, {
      name: post.title, lat: post.lat, lon: post.lon, address: post.address, phone: post.phone,
      location: post.location, category: post.category,
    });
    if (!place) continue;
    await prisma.feedPost.update({ where: { id: post.id }, data: { placeId: place.id } });
    await prisma.placeEvent.create({ data: { placeId: place.id, type: 'REVIEW', userId: post.authorId, postId: post.id, createdAt: post.createdAt } });
    summary.reviews++; summary.events++;
  }

  const msgs = await prisma.message.findMany({
    where: { type: { in: ['LOCATION_SUGGEST', 'LOCATION_NOTICE'] }, locationPlaceId: null },
    orderBy: { createdAt: 'asc' },
  });
  for (const m of msgs) {
    if (typeof m.locationLat !== 'number' || typeof m.locationLon !== 'number' || !m.locationPlace) { summary.skippedNoCoords++; continue; }
    const isSuggest = m.type === 'LOCATION_SUGGEST';
    if (DRY) { summary[isSuggest ? 'suggests' : 'notices']++; continue; }
    const place = await findOrCreatePlace(prisma, {
      name: m.locationPlace, lat: m.locationLat, lon: m.locationLon,
      address: m.locationAddress && m.locationAddress !== m.locationPlace ? m.locationAddress : null,
    });
    if (!place) continue;
    await prisma.message.update({ where: { id: m.id }, data: { locationPlaceId: place.id } });
    const base = { placeId: place.id, userId: m.senderId, chatRoomId: m.chatRoomId, messageId: m.id, createdAt: m.createdAt };
    if (isSuggest) {
      await prisma.placeEvent.create({ data: { ...base, type: 'SUGGEST' } }); summary.events++;
      if (m.locationStatus === 'CONFIRMED') { await prisma.placeEvent.create({ data: { ...base, type: 'CONFIRM' } }); summary.events++; }
      summary.suggests++;
    } else {
      await prisma.placeEvent.create({ data: { ...base, type: 'CONFIRM' } }); summary.events++;
      summary.notices++;
    }
  }

  const placeCount = DRY ? '(미리보기)' : await prisma.place.count();
  console.log(DRY ? '[미리보기]' : '[완료]', summary, 'places:', placeCount);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
