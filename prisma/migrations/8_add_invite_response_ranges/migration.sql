-- 약속 링크 응답을 분 단위로 (예: 16:45부터 가능)
ALTER TABLE "invite_responses" ADD COLUMN IF NOT EXISTS "ranges" TEXT[] DEFAULT ARRAY[]::TEXT[];
