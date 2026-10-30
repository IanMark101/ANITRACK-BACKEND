import type { PrismaClient, WatchStatus, Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { createEntrySchema, updateEntrySchema } from '../validation.js';
import { AppError } from '../errors.js';
import { transactionOptions } from '../transaction-options.js';
import type { AnimeProvider, ProviderAnime } from './anime-provider.js';

const toStatus: Record<string, WatchStatus> = {
  Watching: 'WATCHING',
  Completed: 'COMPLETED',
  'Plan to Watch': 'PLAN_TO_WATCH'
};
const fromStatus = { WATCHING: 'Watching', COMPLETED: 'Completed', PLAN_TO_WATCH: 'Plan to Watch' };
type Entry = Prisma.WatchlistEntryGetPayload<{ include: { anime: true } }>;
const animeSummary = { title: true, genre: true, image: true, synopsis: true,
  provider: true, externalId: true, totalEpisodes: true } as const;
type SummaryEntry = Pick<Entry, 'id' | 'animeId' | 'episodesWatched' | 'rating' | 'status' | 'isFavorite' | 'createdAt'>
  & { anime: Pick<Entry['anime'], keyof typeof animeSummary> };
const serialize = (entry: SummaryEntry) => ({
  id: entry.id,
  animeId: entry.animeId,
  title: entry.anime.title,
  genre: entry.anime.genre,
  image: entry.anime.image,
  synopsis: entry.anime.synopsis,
  provider: entry.anime.provider,
  externalId: entry.anime.externalId,
  totalEpisodes: entry.anime.totalEpisodes,
  episodesWatched: entry.episodesWatched,
  rating: entry.rating,
  status: fromStatus[entry.status],
  isFavorite: entry.isFavorite,
  createdAt: entry.createdAt
});

export function progressChanges(
  current: number,
  total: number | null,
  input: { episodesWatched?: number; status?: string }
) {
  let episodesWatched = input.episodesWatched;
  let status = input.status;
  if (episodesWatched !== undefined) {
    if (
      !Number.isInteger(episodesWatched) ||
      episodesWatched < 0 ||
      episodesWatched > 50000 ||
      (total !== null && episodesWatched > total)
    )
      throw new AppError(
        400,
        'INVALID_PROGRESS',
        total
          ? `Progress must be between 0 and ${total} episodes.`
          : 'Progress must be a non-negative whole number.'
      );
    if (!status)
      status =
        total !== null && episodesWatched === total
          ? 'Completed'
          : episodesWatched > 0
            ? 'Watching'
            : 'Plan to Watch';
  } else if (status === 'Completed' && total !== null) episodesWatched = Math.max(current, total);
  return {
    ...(episodesWatched !== undefined ? { episodesWatched } : {}),
    ...(status ? { status: toStatus[status] } : {})
  };
}

export function createWatchlistService(db: PrismaClient, provider?: AnimeProvider, collectionLimit = 500) {
  async function lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.user.update({ where: { id: userId }, data: { id: userId }, select: { id: true } });
  }
  async function assertRoom(tx: Prisma.TransactionClient, userId: string) {
    if (await tx.watchlistEntry.count({ where: { userId } }) >= collectionLimit)
      throw new AppError(409, 'COLLECTION_LIMIT', `Your collection can contain up to ${collectionLimit} titles. Remove a title before adding another.`);
  }
  async function ownedEntry(userId: string, id: string) {
    const entry = await db.watchlistEntry.findFirst({
      where: { id, userId },
      include: { anime: true }
    });
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Watchlist entry not found.');
    return entry;
  }
  return {
    async list(userId: string, page = 1, limit = 20) {
      const [entries, user] = await Promise.all([
        db.watchlistEntry.findMany({
          where: { userId },
          include: { anime: { select: animeSummary } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit, take: limit + 1
        }),
        db.user.findUniqueOrThrow({ where: { id: userId }, select: { spotlightId: true } })
      ]);
      return { items: entries.slice(0, limit).map(serialize), spotlightId: user.spotlightId,
        page, hasNext: entries.length > limit };
    },
    async get(userId: string, id: string) {
      return serialize(await ownedEntry(userId, id));
    },
    async create(userId: string, input: z.infer<typeof createEntrySchema>) {
      const entry = await db.$transaction(async (tx) => {
        await lockUser(tx, userId);
        await assertRoom(tx, userId);
        let animeId: string;
        let totalEpisodes: number | null;
        if ('animeId' in input) {
          const anime = await tx.anime.findFirst({
            where: { id: input.animeId, OR: [{ ownerId: null }, { ownerId: userId }] },
            select: { id: true, totalEpisodes: true }
          });
          if (!anime) throw new AppError(404, 'NOT_FOUND', 'Anime not found.');
          animeId = anime.id;
          totalEpisodes = anime.totalEpisodes;
        } else {
          const anime = await tx.anime.create({
            data: {
              title: input.title,
              genre: input.genre,
              image: input.image,
              synopsis: input.synopsis,
              totalEpisodes: input.totalEpisodes ?? null,
              ownerId: userId
            },
            select: { id: true, totalEpisodes: true }
          });
          animeId = anime.id;
          totalEpisodes = anime.totalEpisodes;
        }
        const created = await tx.watchlistEntry.create({
          data: {
            userId,
            animeId,
            rating: input.rating,
            status: toStatus[input.status],
            isFavorite: input.isFavorite,
            ...progressChanges(0, totalEpisodes, { status: input.status })
          },
          include: { anime: true }
        });
        await tx.user.update({ where: { id: userId }, data: { spotlightId: created.id } });
        return created;
      }, transactionOptions);
      return serialize(entry);
    },
    async update(userId: string, id: string, input: z.infer<typeof updateEntrySchema>) {
      const existing = await ownedEntry(userId, id);
      const progress = progressChanges(
        existing.episodesWatched,
        existing.anime.totalEpisodes,
        input
      );
      return serialize(
        await db.watchlistEntry.update({
          where: { id },
          data: { ...input, ...progress, status: progress.status },
          include: { anime: true }
        })
      );
    },
    async importAnime(userId: string, externalId: string) {
      if (!provider)
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Anime discovery is unavailable.');
      const saved = await db.anime.findUnique({
        where: { provider_externalId: { provider: 'KITSU', externalId } }
      });
      let details: ProviderAnime;
      try {
        details = await provider.get(externalId);
      } catch (error) {
        if (!saved?.details || (error instanceof AppError && error.status === 404)) throw error;
        details = saved.details as unknown as ProviderAnime;
      }
      return db.$transaction(async (tx) => {
        await lockUser(tx, userId);
        const data = {
          title: details.title,
          image: details.image,
          synopsis: details.synopsis,
          genre: details.genres[0] || 'Uncategorized',
          totalEpisodes: details.totalEpisodes,
          details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue
        };
        const anime = await tx.anime.upsert({
          where: { provider_externalId: { provider: 'KITSU', externalId } },
          create: { ...data, provider: 'KITSU', externalId },
          update: data,
          select: { id: true }
        });
        const previous = await tx.watchlistEntry.findUnique({
          where: { userId_animeId: { userId, animeId: anime.id } }
        });
        if (!previous) await assertRoom(tx, userId);
        const entry = await tx.watchlistEntry.upsert({
          where: { userId_animeId: { userId, animeId: anime.id } },
          create: { userId, animeId: anime.id },
          update: {},
          include: { anime: true }
        });
        if (!previous)
          await tx.user.update({ where: { id: userId }, data: { spotlightId: entry.id } });
        return { item: serialize(entry), created: !previous };
      }, transactionOptions);
    },
    async progress(userId: string, id: string, delta: number) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await db.$transaction(
            async (tx) => {
              const entry = await tx.watchlistEntry.findFirst({
                where: { id, userId },
                include: { anime: true }
              });
              if (!entry) throw new AppError(404, 'NOT_FOUND', 'Watchlist entry not found.');
              const data = progressChanges(entry.episodesWatched, entry.anime.totalEpisodes, {
                episodesWatched: entry.episodesWatched + delta
              });
              return serialize(
                await tx.watchlistEntry.update({ where: { id }, data, include: { anime: true } })
              );
            },
            { ...transactionOptions, isolationLevel: 'Serializable' }
          );
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2034' || attempt === 2) throw error;
        }
      }
      throw new AppError(409, 'PROGRESS_CONFLICT', 'Please reload your collection and try again.');
    },
    async calendar(userId: string, week: string) {
      if (!provider)
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Anime discovery is unavailable.');
      const entries = await db.watchlistEntry.findMany({
        where: { userId, status: 'WATCHING', anime: { provider: 'KITSU' } },
        include: { anime: true },
        orderBy: { updatedAt: 'desc' },
        take: 21
      });
      const end = new Date(`${week}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 7);
      const last = end.toISOString().slice(0, 10);
      type CalendarEvent = {
        date: string;
        title: string;
        image: string;
        externalId: string;
        episode: number | null;
        episodeTitle: string;
        kind: string;
      };
      const events: CalendarEvent[] = [];
      let failed = 0;
      let next = 0;
      let halted = false;
      const selected = entries.slice(0, 20);
      await Promise.all(
        Array.from({ length: Math.min(3, selected.length) }, async () => {
          while (next < selected.length && !halted) {
            const entry = selected[next++];
            const anime = entry.anime;
            try {
              const first = await provider.episodes(anime.externalId!);
              const latest =
                first.total && first.total > 20
                  ? await provider.episodes(anime.externalId!, Math.ceil(first.total / 20))
                  : first;
              for (const episode of latest.items) {
                if (episode.airDate && episode.airDate >= week && episode.airDate < last)
                  events.push({
                    date: episode.airDate,
                    title: anime.title,
                    image: anime.image,
                    externalId: anime.externalId!,
                    episode: episode.number,
                    episodeTitle: episode.title,
                    kind: 'Episode'
                  });
              }
              const details = anime.details as unknown as ProviderAnime | null;
              if (details?.nextRelease) {
                const date = details.nextRelease.slice(0, 10);
                if (
                  date >= week &&
                  date < last &&
                  !events.some(
                    (event) => event.externalId === anime.externalId && event.date === date
                  )
                )
                  events.push({
                    date,
                    title: anime.title,
                    image: anime.image,
                    externalId: anime.externalId!,
                    episode: null,
                    episodeTitle: 'Next release',
                    kind: 'Release'
                  });
              }
            } catch (error) {
              failed++;
              if (error instanceof AppError && error.status === 503) halted = true;
            }
          }
        })
      );
      return {
        events: events.sort(
          (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)
        ),
        week,
        trackedTitles: selected.length,
        failedTitles: failed + selected.length - next,
        limited: entries.length > 20,
        notice:
          'Known dates for the latest episodes of your Watching titles. Release dates may be incomplete; exact streaming times are not provided.'
      };
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
      }, transactionOptions);
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
      if (catalog.length > collectionLimit)
        throw new AppError(409, 'COLLECTION_LIMIT', 'The starter collection exceeds your collection limit.');
      await db.$transaction(async (tx) => {
        await lockUser(tx, userId);
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
      }, transactionOptions);
      return this.list(userId);
    }
  };
}
