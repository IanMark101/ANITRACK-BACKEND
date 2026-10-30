ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
CREATE TYPE "AccountTokenPurpose" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION');
CREATE TABLE "AccountToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "purpose" "AccountTokenPurpose" NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken"("tokenHash");
CREATE INDEX "AccountToken_userId_purpose_idx" ON "AccountToken"("userId", "purpose");
CREATE INDEX "AccountToken_expiresAt_idx" ON "AccountToken"("expiresAt");
CREATE TABLE "AssistantUsageDay" (
  "day" DATE NOT NULL PRIMARY KEY,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "reservedMicros" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0
);
