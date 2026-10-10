-- 직접 고르기 링크: 날짜마다 따로 연 1시간 칸 "YYYY-MM-DD|HH" (캘린더 일정과는 상관없이 링크에만 저장, 비어 있으면 범위 안 전부)
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "manualCells" TEXT[] DEFAULT ARRAY[]::TEXT[];
