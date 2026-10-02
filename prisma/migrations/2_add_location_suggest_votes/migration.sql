-- CreateTable: 장소 제안 후보 투표
CREATE TABLE IF NOT EXISTS "location_suggest_votes" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "location_suggest_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "location_suggest_votes_messageId_userId_key" ON "location_suggest_votes"("messageId", "userId");

DO $$ BEGIN
  ALTER TABLE "location_suggest_votes" ADD CONSTRAINT "location_suggest_votes_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "location_suggest_votes" ADD CONSTRAINT "location_suggest_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
