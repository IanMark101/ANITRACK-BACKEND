import type { PrismaClient, WatchStatus, Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { createEntrySchema, updateEntrySchema } from '../validation.js';
import { AppError } from '../errors.js';

const toStatus: Record<string, WatchStatus> = {
  Watching: 'WATCHING',
  Completed: 'COMPLETED',
  'Plan to Watch': 'PLAN_TO_WATCH'
};
const fromStatus = { WATCHING: 'Watching', COMPLETED: 'Completed', PLAN_TO_WATCH: 'Plan to Watch' };
type Entry = Prisma.WatchlistEntryGetPayload<{ include: { anime: true } }>;
const serialize = (entry: Entry) => ({
  id: entry.id,
  animeId: entry.animeId,
  title: entry.anime.title,
  genre: entry.anime.genre,
  image: entry.anime.image,
  synopsis: entry.anime.synopsis,
  rating: entry.rating,
  status: fromStatus[entry.status],
  isFavorite: entry.isFavorite,
  createdAt: entry.createdAt
});

export function createWatchlistService(db: PrismaClient) {
  async function ownedEntry(userId: string, id: string) {
    const entry = await db.watchlistEntry.findFirst({
      where: { id, userId },
      include: { anime: true }
    });
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Watchlist entry not found.');
    return entry;
  }
  return {
    async list(userId: string) {
      const [entries, user] = await Promise.all([
        db.watchlistEntry.findMany({
          where: { userId },
          include: { anime: true },
          orderBy: { createdAt: 'desc' }
        }),
        db.user.findUniqueOrThrow({ where: { id: userId }, select: { spotlightId: true } })
      ]);
      return { items: entries.map(serialize), spotlightId: user.spotlightId };
    },
    async get(userId: string, id: string) {
      return serialize(await ownedEntry(userId, id));
    },
    async create(userId: string, input: z.infer<typeof createEntrySchema>) {
      const entry = await db.$transaction(async (tx) => {
        let animeId: string;
        if ('animeId' in input) {
          const anime = await tx.anime.findFirst({
            where: { id: input.animeId, OR: [{ ownerId: null }, { ownerId: userId }] }
          });
          if (!anime) throw new AppError(404, 'NOT_FOUND', 'Anime not found.');
          animeId = anime.id;
        } else {
          const anime = await tx.anime.create({
            data: {
              title: input.title,
              genre: input.genre,
              image: input.image,
              synopsis: input.synopsis,
              ownerId: userId
            }
          });
          animeId = anime.id;
        }
        const created = await tx.watchlistEntry.create({
          data: {
            userId,
            animeId,
            rating: input.rating,
            status: toStatus[input.status],
            isFavorite: input.isFavorite
          },
          include: { anime: true }
        });
        await tx.user.update({ where: { id: userId }, data: { spotlightId: created.id } });
        return created;
      });
      return serialize(entry);
    },
    async update(userId: string, id: string, input: z.infer<typeof updateEntrySchema>) {
      await ownedEntry(userId, id);
      return serialize(
        await db.watchlistEntry.update({
          where: { id },
          data: { ...input, status: input.status ? toStatus[input.status] : undefined },
          include: { anime: true }
        })
      );
    },
    async remove(userId: string, id: string) {
      const entry = await ownedEntry(userId, id);
      await db.$transaction(async (tx) => {
        await tx.watchlistEntry.delete({ where: { id } });
        await tx.user.updateMany({
          where: { id: userId, spotlightId: id },
          data: { spotlightId: null }
        });
        if (entry.anime.ownerId === userId) await tx.anime.delete({ where: { id: entry.animeId } });
      });
    },
    async spotlight(userId: string, id: string | null) {
      if (id) await ownedEntry(userId, id);
      await db.user.update({ where: { id: userId }, data: { spotlightId: id } });
      return { spotlightId: id };
    },
    async reset(userId: string) {
      const catalog = await db.anime.findMany({
        where: { ownerId: null, slug: { not: null } },
        orderBy: { title: 'asc' }
      });
      if (!catalog.length)
        throw new AppError(
          409,
          'CATALOG_EMPTY',
          'The catalog has not been seeded. Please add anime manually.'
        );
      await db.$transaction(async (tx) => {
        await tx.watchlistEntry.deleteMany({ where: { userId } });
        await tx.anime.deleteMany({ where: { ownerId: userId } });
        await tx.watchlistEntry.createMany({
          data: catalog.map((anime) => ({
            userId,
            animeId: anime.id,
            rating: 8.5,
            status: 'PLAN_TO_WATCH' as const
          }))
        });
        await tx.user.update({ where: { id: userId }, data: { spotlightId: null } });
      });
      return this.list(userId);
    }
  };
}
