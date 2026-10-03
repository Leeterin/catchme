-- '친구가 아닌 사람의 채팅 요청 허용' 기본값을 켜짐으로 (기존에 저장된 값도 기본값이었던 false를 전부 켜짐으로)
ALTER TABLE "user_settings" ALTER COLUMN "privStrangerChat" SET DEFAULT true;
UPDATE "user_settings" SET "privStrangerChat" = true WHERE "privStrangerChat" = false;
