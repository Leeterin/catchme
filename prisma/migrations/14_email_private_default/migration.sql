-- 새로 가입하는 사람의 이메일 "친구에게 공개" 기본값을 비공개로 (전화번호와 같게)
-- (기본값만 바꿈 - 이미 가입한 사람의 설정은 그대로 둠)
ALTER TABLE "users" ALTER COLUMN "emailPublic" SET DEFAULT false;
