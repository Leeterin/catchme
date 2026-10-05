-- 리뷰 저장(⭐ 나중에 가볼 곳) - 예전엔 앱 메모리에만 들고 있어서 앱을 껐다 켜면 사라졌음
CREATE TABLE IF NOT EXISTS "feed_post_saves" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feed_post_saves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "feed_post_saves_postId_userId_key" ON "feed_post_saves"("postId", "userId");
CREATE INDEX IF NOT EXISTS "feed_post_saves_userId_idx" ON "feed_post_saves"("userId");
ALTER TABLE "feed_post_saves" ADD CONSTRAINT "feed_post_saves_postId_fkey" FOREIGN KEY ("postId") REFERENCES "feed_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feed_post_saves" ADD CONSTRAINT "feed_post_saves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
