-- 설정 > 홈 화면 편집: 꺼서 홈에 안 보이게 한 카드 이름 배열
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "homeHidden" TEXT[] DEFAULT ARRAY[]::TEXT[];
