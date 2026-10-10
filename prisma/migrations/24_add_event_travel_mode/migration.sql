-- 일정 이동 수단(자동차/대중교통) 저장 - 다시 불러와도 고른 수단이 그대로 유지되게
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "travelMode" TEXT;
