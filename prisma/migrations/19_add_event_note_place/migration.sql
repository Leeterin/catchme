-- 일정 메모·장소 (나만 보는 정보) - 일정 수정 화면과 일정 칸을 눌렀을 때 보여줌. 모두 비어 있으면 메모/장소 없음
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "placeName" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "placeAddress" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "placeLat" DOUBLE PRECISION;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "placeLon" DOUBLE PRECISION;
