-- 약속 초대 링크 + 비회원 응답
DO $$ BEGIN
  CREATE TYPE "InviteStatus" AS ENUM ('OPEN', 'CONFIRMED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "invite_polls" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dates" TEXT[],
    "startHour" INTEGER NOT NULL,
    "endHour" INTEGER NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'OPEN',
    "confirmedStart" TIMESTAMP(3),
    "confirmedEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invite_polls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "invite_responses" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "guestKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "cells" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invite_responses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invite_polls_token_key" ON "invite_polls"("token");
CREATE INDEX IF NOT EXISTS "invite_polls_creatorId_idx" ON "invite_polls"("creatorId");
CREATE UNIQUE INDEX IF NOT EXISTS "invite_responses_pollId_guestKey_key" ON "invite_responses"("pollId", "guestKey");

DO $$ BEGIN
  ALTER TABLE "invite_polls" ADD CONSTRAINT "invite_polls_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "invite_responses" ADD CONSTRAINT "invite_responses_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "invite_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "invite_responses" ADD CONSTRAINT "invite_responses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
