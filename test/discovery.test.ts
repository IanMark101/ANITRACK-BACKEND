import { describe, expect, it, vi } from 'vitest';
import { createAnimeProvider, normalizeAnime } from '../src/services/anime-provider.js';
import { progressChanges } from '../src/services/watchlist.service.js';
import {
  calendarQuerySchema,
  discoveryQuerySchema,
  externalIdSchema,
  updateEntrySchema
} from '../src/validation.js';

const anime = {
  id: '123',
  type: 'anime',
  attributes: {
    titles: { en: 'A story', ja_jp: '物語' },
    canonicalTitle: 'Monogatari',
    synopsis: '<p>A thoughtful story.</p>',
    posterImage: { large: 'https://media.kitsu.app/cover.jpg' },
    averageRating: '85.5',
    episodeCount: 12,
    startDate: '2026-10-01',
    youtubeVideoId: 'abcdefghijk',
    status: 'current',
    subtype: 'TV'
  },
  relationships: { categories: { data: [{ id: '1', type: 'categories' }] } }
};
const included = [
  { id: '1', type: 'categories', attributes: { title: 'Fantasy', slug: 'fantasy' } },
  { id: '2', type: 'categories', attributes: { title: 'Romance', slug: 'romance' } }
];
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('Anime metadata integration', () => {
  it('treats malformed external dates and fractional episode totals as unknown', () => {
    const result = normalizeAnime({
      ...anime,
      attributes: { ...anime.attributes, startDate: '2026-02-30', episodeCount: 2.5 }
    });
    expect(result.startDate).toBeNull();
    expect(result.season).toBeNull();
    expect(result.totalEpisodes).toBeNull();
  });
  it('normalizes provider scores, titles and only the categories belonging to this anime', () => {
    const result = normalizeAnime(anime, included);
    expect(result).toMatchObject({
      title: 'A story',
      genres: ['Fantasy'],
      categorySlugs: ['fantasy'],
      communityScore: 8.55,
      totalEpisodes: 12,
      season: 'fall',
      year: 2026,
      synopsis: 'A thoughtful story.'
    });
    expect(result.alternativeTitles).toContain('物語');
  });
  it('leaves unknown totals and scores unknown and rejects unsafe images and trailer IDs', () => {
    const result = normalizeAnime({
      ...anime,
      attributes: {
        ...anime.attributes,
        episodeCount: null,
        averageRating: null,
        posterImage: { large: 'javascript:alert(1)' },
        youtubeVideoId: 'bad/id?x=1'
      }
    });
    expect(result.totalEpisodes).toBeNull();
    expect(result.communityScore).toBeNull();
    expect(result.trailerId).toBeNull();
    expect(result.image).toMatch(/^\/images\//);
  });
  it('coalesces duplicate requests, caches details, and refreshes expired cache entries', async () => {
    let time = 1000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ data: anime, included }));
    const provider = createAnimeProvider(fetcher, () => time);
    await Promise.all([provider.get('123'), provider.get('123')]);
    await provider.get('123');
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += 7 * 60 * 60_000;
    await provider.get('123');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('encodes searches and applies pagination and explicit seasonal filters', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response({ data: [anime], included, links: { next: 'next' }, meta: { count: 100 } })
      );
    const provider = createAnimeProvider(fetcher);
    const result = await provider.search({ q: 'A & B', page: 2, genre: 'Fantasy' });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('filter[text]')).toBe('A & B');
    expect(url.searchParams.get('page[offset]')).toBe('12');
    expect(result.hasNext).toBe(true);
    await provider.search({ view: 'seasonal', year: 2025, season: 'winter' });
    const seasonal = new URL(String(fetcher.mock.calls[1][0]));
    expect(seasonal.searchParams.get('filter[seasonYear]')).toBe('2025');
    expect(seasonal.searchParams.get('filter[season]')).toBe('winter');
  });
  it.each([429, 500])(
    'maps provider failure %s to a retryable service response',
    async (status) => {
      const provider = createAnimeProvider(
        vi.fn<typeof fetch>().mockImplementation(async () => response({}, status))
      );
      await expect(provider.search()).rejects.toMatchObject({
        status: 503,
        code: 'PROVIDER_UNAVAILABLE'
      });
    }
  );
  it('does not treat a missing title as a temporary outage', async () => {
    const provider = createAnimeProvider(
      vi.fn<typeof fetch>().mockImplementation(async () => response({}, 404))
    );
    await expect(provider.get('999')).rejects.toMatchObject({
      status: 404,
      code: 'ANIME_NOT_FOUND'
    });
  });
  it('keeps manga adaptations out of related-anime results', async () => {
    const provider = createAnimeProvider(
      vi.fn<typeof fetch>().mockImplementation(async () =>
        response({
          data: [
            {
              id: 'r1',
              type: 'mediaRelationships',
              attributes: { role: 'adaptation' },
              relationships: { destination: { data: { type: 'manga', id: '2' } } }
            },
            {
              id: 'r2',
              type: 'mediaRelationships',
              attributes: { role: 'sequel' },
              relationships: { destination: { data: { type: 'anime', id: '123' } } }
            }
          ],
          included: [anime]
        })
      )
    );
    const result = await provider.relations('1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].relation).toBe('sequel');
  });
});

describe('Episode progress rules', () => {
  it('starts watching on the first episode and completes at the known total', () => {
    expect(progressChanges(0, 12, { episodesWatched: 1 })).toEqual({
      episodesWatched: 1,
      status: 'WATCHING'
    });
    expect(progressChanges(11, 12, { episodesWatched: 12 })).toEqual({
      episodesWatched: 12,
      status: 'COMPLETED'
    });
    expect(progressChanges(12, 12, { episodesWatched: 11 })).toEqual({
      episodesWatched: 11,
      status: 'WATCHING'
    });
  });
  it('allows tracking an unknown total without auto-completing', () => {
    expect(progressChanges(25, null, { episodesWatched: 26 })).toEqual({
      episodesWatched: 26,
      status: 'WATCHING'
    });
  });
  it.each([-1, 1.2, 13, 50001])('rejects invalid progress %s', (episodesWatched) => {
    expect(() => progressChanges(0, 12, { episodesWatched })).toThrow();
  });
  it('does not change progress or status for a rating-only patch', () => {
    expect(progressChanges(7, 12, {})).toEqual({});
    expect(updateEntrySchema.parse({ rating: 9.1 })).toEqual({ rating: 9.1 });
  });
  it('fills known episode totals when marking a title completed', () => {
    expect(progressChanges(7, 12, { status: 'Completed' })).toEqual({
      episodesWatched: 12,
      status: 'COMPLETED'
    });
  });
});

describe('External query validation', () => {
  it('rejects URL-shaped IDs, oversized pages and invalid calendar dates', () => {
    expect(externalIdSchema.safeParse('https://example.test').success).toBe(false);
    expect(discoveryQuerySchema.safeParse({ page: 999999 }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ week: '2026-02-30' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ week: '2026-10-26' }).success).toBe(true);
  });
});
