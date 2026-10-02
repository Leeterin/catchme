-- AlterTable: 일정별 색상 (null이면 테마 기본 색)
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "color" TEXT;
