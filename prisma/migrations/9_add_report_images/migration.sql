-- 오류 신고에 사진(스크린샷) 첨부 - base64 data URL, 최대 3장
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "images" TEXT[] DEFAULT ARRAY[]::TEXT[];
