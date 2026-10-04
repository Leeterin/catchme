-- 예약 가능 시간을 누구에게 열지(모두/친구만/일만) + 초대 링크 용도(친구용/일용)
-- (추가만 함 - 기존 일정은 "모두", 기존 링크는 "친구용"이라 지금과 똑같이 동작)
ALTER TABLE "events" ADD COLUMN "availableFor" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "invite_polls" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'friends';
