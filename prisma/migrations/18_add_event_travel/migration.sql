-- 일정 이동시간 (켠 사람만 쓰는 기능) - 목적지/출발지와 카카오 대중교통으로 구한 이동시간(분)
-- 캘린더에서 일정 바로 앞에 "이동시간" 칸으로 보여줌. 모두 비어 있으면 이동시간 없음
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelMinutes" INTEGER;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelToName" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelToLat" DOUBLE PRECISION;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelToLon" DOUBLE PRECISION;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelFromName" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelFromLat" DOUBLE PRECISION;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelFromLon" DOUBLE PRECISION;
