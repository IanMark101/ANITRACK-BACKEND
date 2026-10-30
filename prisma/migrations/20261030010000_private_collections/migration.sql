CREATE TABLE "Collection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Collection_userId_createdAt_idx" ON "Collection"("userId", "createdAt");
CREATE TABLE "CollectionItem" (
  "collectionId" TEXT NOT NULL REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "entryId" TEXT NOT NULL REFERENCES "WatchlistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "position" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("collectionId", "entryId")
);
CREATE INDEX "CollectionItem_entryId_idx" ON "CollectionItem"("entryId");
