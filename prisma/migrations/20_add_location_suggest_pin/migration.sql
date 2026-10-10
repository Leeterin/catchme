-- 장소 제안이 어느 약속(상단 고정 카드)을 위한 건지, 확정된 "장소만 있는 핀"이 어느 약속의 장소인지
-- (비어 있으면 아직 날짜 미정 약속 / 예전 데이터)
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "locationPinId" TEXT;
ALTER TABLE "pinned_items" ADD COLUMN IF NOT EXISTS "forPinId" TEXT;
