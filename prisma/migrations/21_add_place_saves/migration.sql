-- 장소 저장(⭐ 나중에 가볼 곳) - 예전엔 리뷰 하나를 저장했는데, 이제 장소 자체를 저장함
CREATE TABLE IF NOT EXISTS "place_saves" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "place_saves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "place_saves_placeId_userId_key" ON "place_saves"("placeId", "userId");
CREATE INDEX IF NOT EXISTS "place_saves_userId_idx" ON "place_saves"("userId");
DO $$ BEGIN
  ALTER TABLE "place_saves" ADD CONSTRAINT "place_saves_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "place_saves" ADD CONSTRAINT "place_saves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 예전에 리뷰로 저장해둔 것은 그 리뷰의 장소를 저장한 것으로 옮김
INSERT INTO "place_saves" ("id", "placeId", "userId", "createdAt")
SELECT gen_random_uuid()::text, f."placeId", s."userId", MIN(s."createdAt")
FROM "feed_post_saves" s JOIN "feed_posts" f ON f."id" = s."postId"
WHERE f."placeId" IS NOT NULL
GROUP BY f."placeId", s."userId"
ON CONFLICT ("placeId", "userId") DO NOTHING;
