-- 사용 지표(활성화/재방문) + 정기 알림 설정. 새 테이블만 추가 - 기존 테이블은 건드리지 않음
CREATE TABLE IF NOT EXISTS "user_active_days" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    CONSTRAINT "user_active_days_pkey" PRIMARY KEY ("userId","day")
);
CREATE INDEX IF NOT EXISTS "user_active_days_day_idx" ON "user_active_days"("day");
ALTER TABLE "user_active_days" ADD CONSTRAINT "user_active_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "analytics_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "props" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_events_name_createdAt_idx" ON "analytics_events"("name", "createdAt");
CREATE INDEX IF NOT EXISTS "analytics_events_userId_name_idx" ON "analytics_events"("userId", "name");
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "user_engagement" (
    "userId" TEXT NOT NULL,
    "morningBrief" BOOLEAN NOT NULL DEFAULT true,
    "weeklyNudge" BOOLEAN NOT NULL DEFAULT true,
    "lastMorningOn" TEXT,
    "lastWeeklyOn" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_engagement_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "user_engagement" ADD CONSTRAINT "user_engagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
