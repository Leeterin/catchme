-- 고정 카드(핀) 장소의 주소
ALTER TABLE "pinned_items" ADD COLUMN IF NOT EXISTS "locationAddress" TEXT;
