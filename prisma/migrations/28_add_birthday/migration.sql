-- 홈 '친구 생일' 위젯: 생일(월-일, "MM-DD")과 친구에게 공개 여부 (기본 비공개)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "birthday" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "birthdayPublic" BOOLEAN NOT NULL DEFAULT false;
