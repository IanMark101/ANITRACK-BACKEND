import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { animeSchema } from '../validation.js';
import { genres, statuses } from '../validation.js';
import { AppError } from '../errors.js';

export function createCatalogService(db: PrismaClient) {
  return {
    async list(page = 1, limit = 50) {
      const items = await db.anime.findMany({ where: { ownerId: null },
        select: { id: true, title: true, genre: true, image: true, synopsis: true,
          provider: true, externalId: true, totalEpisodes: true },
        orderBy: [{ title: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit + 1 });
      return {
        items: items.slice(0, limit), page, hasNext: items.length > limit
      };
    },
    async meta() {
      const posters = await db.anime.findMany({
        where: { ownerId: null },
        select: { id: true, title: true, image: true },
        orderBy: { title: 'asc' }, take: 20
      });
      return { genres, statuses, posters };
    },
    async get(id: string) {
      const anime = await db.anime.findFirst({ where: { id, ownerId: null } });
      if (!anime) throw new AppError(404, 'NOT_FOUND', 'Catalog anime not found.');
      return anime;
    },
    async create(data: z.infer<typeof animeSchema>) {
      return db.anime.create({ data });
    },
    async update(id: string, data: Partial<z.infer<typeof animeSchema>>) {
      await this.get(id);
      return db.anime.update({ where: { id }, data });
    },
    async remove(id: string) {
      await this.get(id);
      if (await db.watchlistEntry.count({ where: { animeId: id } }))
        throw new AppError(
          409,
          'ANIME_IN_USE',
          'This anime is in a watchlist and cannot be deleted.'
        );
      await db.anime.delete({ where: { id } });
    }
  };
}
