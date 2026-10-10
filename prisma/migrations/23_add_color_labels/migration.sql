-- 일정 색 라벨 10개 이름 (빈칸 = 기본 이름). 색은 앱에 고정
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "colorLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];
