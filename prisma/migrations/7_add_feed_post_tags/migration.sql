-- 약속이 끝난 뒤 채팅방에서 남기는 장소 후기 (항목 태그 + 약속 후기 표시)
ALTER TABLE "feed_posts" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "feed_posts" ADD COLUMN IF NOT EXISTS "fromMeetup" BOOLEAN NOT NULL DEFAULT false;
