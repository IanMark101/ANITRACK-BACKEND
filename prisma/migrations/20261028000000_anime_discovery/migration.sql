ALTER TABLE "Anime"
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "totalEpisodes" INTEGER,
  ADD COLUMN "details" JSONB;

ALTER TABLE "WatchlistEntry" ADD COLUMN "episodesWatched" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Anime_provider_externalId_key" ON "Anime"("provider", "externalId");
ALTER TABLE "Anime" ADD CONSTRAINT "Anime_totalEpisodes_check" CHECK ("totalEpisodes" IS NULL OR "totalEpisodes" > 0);
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_episodesWatched_check" CHECK ("episodesWatched" >= 0);
