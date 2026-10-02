-- 약속 링크를 내 캘린더의 예약 가능 시간 기준으로 만들기
ALTER TABLE "invite_polls" ADD COLUMN IF NOT EXISTS "fromCalendar" BOOLEAN NOT NULL DEFAULT false;
