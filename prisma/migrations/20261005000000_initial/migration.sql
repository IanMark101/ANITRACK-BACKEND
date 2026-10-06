-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "WatchStatus" AS ENUM ('WATCHING', 'COMPLETED', 'PLAN_TO_WATCH');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "spotlightId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Anime" (
    "id" TEXT NOT NULL,
    "slug" TEXT,
    "title" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "synopsis" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "animeId" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 8.5,
    "status" "WatchStatus" NOT NULL DEFAULT 'PLAN_TO_WATCH',
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Anime_slug_key" ON "Anime"("slug");

-- CreateIndex
CREATE INDEX "Anime_ownerId_idx" ON "Anime"("ownerId");

-- CreateIndex
CREATE INDEX "WatchlistEntry_userId_status_idx" ON "WatchlistEntry"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistEntry_userId_animeId_key" ON "WatchlistEntry"("userId", "animeId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_idx" ON "RefreshSession"("userId");

-- CreateIndex
CREATE INDEX "RefreshSession_familyId_idx" ON "RefreshSession"("familyId");

-- CreateIndex
CREATE INDEX "RefreshSession_expiresAt_idx" ON "RefreshSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "Anime" ADD CONSTRAINT "Anime_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_animeId_fkey" FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
