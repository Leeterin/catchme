-- 캐치미 자체 장소 DB: places 테이블 확장 + 장소 행동 기록(place_events) + 메시지/리뷰를 장소에 연결
-- (추가만 함 - 기존 데이터는 지우거나 바꾸지 않음. 리뷰의 장소 FK만 CASCADE -> SET NULL로 완화)

-- AlterTable: places
ALTER TABLE "places" ADD COLUMN "normName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "categoryDetail" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "kakaoPlaceId" TEXT,
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "places_kakaoPlaceId_key" ON "places"("kakaoPlaceId");
CREATE INDEX "places_normName_idx" ON "places"("normName");

-- AlterTable: messages
ALTER TABLE "messages" ADD COLUMN "locationPlaceId" TEXT;
CREATE INDEX "messages_locationPlaceId_idx" ON "messages"("locationPlaceId");

-- CreateTable: place_events
CREATE TABLE "place_events" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "chatRoomId" TEXT,
    "messageId" TEXT,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "place_events_placeId_type_idx" ON "place_events"("placeId", "type");
CREATE INDEX "place_events_createdAt_idx" ON "place_events"("createdAt");
ALTER TABLE "place_events" ADD CONSTRAINT "place_events_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 리뷰 -> 장소 FK: 장소가 지워져도 리뷰는 남게 (CASCADE -> SET NULL)
ALTER TABLE "feed_posts" DROP CONSTRAINT "feed_posts_placeId_fkey";
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;
