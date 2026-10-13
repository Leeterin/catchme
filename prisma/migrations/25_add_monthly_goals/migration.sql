-- 홈 "이번 달 목표" (운동·책 읽기 등) - 목표와 달별로 직접 누른 횟수
CREATE TABLE IF NOT EXISTS "monthly_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "monthly_goals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "monthly_goals_userId_idx" ON "monthly_goals"("userId");
ALTER TABLE "monthly_goals" ADD CONSTRAINT "monthly_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "monthly_goal_counts" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "monthly_goal_counts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_goal_counts_goalId_month_key" ON "monthly_goal_counts"("goalId", "month");
ALTER TABLE "monthly_goal_counts" ADD CONSTRAINT "monthly_goal_counts_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "monthly_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
