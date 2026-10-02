-- 약속 초대 링크에 장소(추천 게시물에서 고른 곳) 붙이기
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "placeName" TEXT;
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "placeAddress" TEXT;
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "placeLat" DOUBLE PRECISION;
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "placeLon" DOUBLE PRECISION;
