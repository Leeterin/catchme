-- 친구 그룹마다 이모티콘(없으면 앱에서 👥) + 업무용 링크 이모티콘(기본 💼)
-- (추가만 함 - 기존 그룹/설정은 지금과 똑같이 보임)
ALTER TABLE "friend_groups" ADD COLUMN IF NOT EXISTS "emoji" TEXT;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "workEmoji" TEXT NOT NULL DEFAULT '💼';
