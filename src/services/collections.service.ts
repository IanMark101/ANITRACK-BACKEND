import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../errors.js';
import { transactionOptions } from '../transaction-options.js';

export function createCollectionsService(db: PrismaClient) {
  const owned = async (userId: string, id: string) => {
    const row = await db.collection.findFirst({ where: { id, userId } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Collection not found.');
    return row;
  };
  const lock = async (tx: Prisma.TransactionClient, userId: string, id: string) => {
    // An ORM update takes a row lock and honors Prisma's configured schema, including
    // isolated test schemas and pooled connections with a different search_path.
    const result = await tx.collection.updateMany({ where: { id, userId }, data: { updatedAt: new Date() } });
    if (!result.count) throw new AppError(404, 'NOT_FOUND', 'Collection not found.');
  };
  return {
    async list(userId: string, page = 1, query = '') {
      const rows = await db.collection.findMany({ where: { userId, ...(query ? { OR: [
        { name: { contains: query, mode: 'insensitive' as const } },
        { description: { contains: query, mode: 'insensitive' as const } }
      ] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 12, take: 13,
        include: { _count: { select: { items: true } }, items: { take: 3,
          orderBy: [{ position: 'asc' }, { entryId: 'asc' }],
          select: { entry: { select: { id: true, anime: { select: { title: true, image: true } } } } } } } });
      return { items: rows.slice(0, 12).map((row) => ({ id: row.id, name: row.name,
        description: row.description, count: row._count.items,
        covers: row.items.map((item) => ({ id: item.entry.id, ...item.entry.anime })) })),
      page, hasNext: rows.length > 12 };
    },
    async get(userId: string, id: string) {
      const row = await owned(userId, id);
      const items = await db.collectionItem.findMany({ where: { collectionId: id }, take: 100,
        orderBy: [{ position: 'asc' }, { entryId: 'asc' }],
        include: { entry: { select: { id: true, status: true, episodesWatched: true, animeId: true,
          anime: { select: { title: true, image: true, provider: true, externalId: true, totalEpisodes: true } } } } } });
      return { id: row.id, name: row.name, description: row.description,
        items: items.map(({ entry }) => ({ id: entry.id, animeId: entry.animeId,
          episodesWatched: entry.episodesWatched, status: entry.status, ...entry.anime })) };
    },
    async create(userId: string, input: { name: string; description: string }) {
      return db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { id: userId }, select: { id: true } });
        if (await tx.collection.count({ where: { userId } }) >= 20)
          throw new AppError(409, 'COLLECTION_GROUP_LIMIT', 'You can create up to 20 collections.');
        return tx.collection.create({ data: { userId, ...input }, select: { id: true, name: true, description: true } });
      }, transactionOptions);
    },
    async update(userId: string, id: string, input: { name: string; description: string }) {
      await owned(userId, id);
      return db.collection.update({ where: { id, userId }, data: input,
        select: { id: true, name: true, description: true } });
    },
    async remove(userId: string, id: string) {
      const result = await db.collection.deleteMany({ where: { id, userId } });
      if (result.count !== 1) throw new AppError(404, 'NOT_FOUND', 'Collection not found.');
    },
    async add(userId: string, id: string, entryIds: string[]) {
      await db.$transaction(async (tx) => {
        await lock(tx, userId, id);
        const unique = [...new Set(entryIds)];
        const ownedEntries = await tx.watchlistEntry.findMany({ where: { userId, id: { in: unique } }, select: { id: true } });
        if (ownedEntries.length !== unique.length) throw new AppError(404, 'NOT_FOUND', 'One or more watchlist titles are unavailable.');
        const existing = await tx.collectionItem.findMany({ where: { collectionId: id }, select: { entryId: true, position: true } });
        const saved = new Set(existing.map((item) => item.entryId));
        const additions = unique.filter((entryId) => !saved.has(entryId));
        if (existing.length + additions.length > 100)
          throw new AppError(409, 'COLLECTION_ITEM_LIMIT', 'A collection can contain up to 100 titles.');
        const start = Math.max(-1, ...existing.map((item) => item.position)) + 1;
        if (additions.length) await tx.collectionItem.createMany({
          data: additions.map((entryId, index) => ({ collectionId: id, entryId, position: start + index })) });
      }, transactionOptions);
    },
    async removeItem(userId: string, id: string, entryId: string) {
      await db.$transaction(async (tx) => {
        await lock(tx, userId, id);
        const deleted = await tx.collectionItem.deleteMany({ where: { collectionId: id, entryId } });
        if (deleted.count !== 1) throw new AppError(404, 'NOT_FOUND', 'This title is not in the collection.');
      }, transactionOptions);
    },
    async reorder(userId: string, id: string, entryIds: string[]) {
      await db.$transaction(async (tx) => {
        await lock(tx, userId, id);
        const existing = await tx.collectionItem.findMany({ where: { collectionId: id }, select: { entryId: true } });
        const desired = new Set(entryIds);
        if (desired.size !== entryIds.length || existing.length !== entryIds.length || existing.some((item) => !desired.has(item.entryId)))
          throw new AppError(409, 'COLLECTION_CHANGED', 'Your collection changed. Refresh it and try again.');
        // Two bounded batch writes replace only memberships, within this locked
        // transaction. Anime and watchlist progress are never deleted or changed.
        await tx.collectionItem.deleteMany({ where: { collectionId: id } });
        if (entryIds.length) await tx.collectionItem.createMany({ data: entryIds.map((entryId, position) => ({ collectionId: id, entryId, position })) });
      }, transactionOptions);
    }
  };
}
