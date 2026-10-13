-- 설정 > 홈 화면 편집: 홈 카드 순서 (카드 이름 배열, 비어 있으면 기본 순서)
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "homeOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];
