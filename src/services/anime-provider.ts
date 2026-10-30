import { AppError } from '../errors.js';

type Resource = {
  id: string;
  type: string;
  attributes: Record<string, any>;
  relationships?: Record<
    string,
    { data?: { id: string; type: string } | { id: string; type: string }[] }
  >;
};
type Document = {
  data: Resource | Resource[];
  included?: Resource[];
  meta?: { count?: number };
  links?: { next?: string };
};
export interface ProviderAnime {
  externalId: string;
  provider: 'KITSU';
  title: string;
  alternativeTitles: string[];
  image: string;
  banner: string | null;
  synopsis: string;
  genres: string[];
  categorySlugs: string[];
  totalEpisodes: number | null;
  episodeLength: number | null;
  communityScore: number | null;
  popularityRank: number | null;
  format: string;
  airingStatus: string;
  startDate: string | null;
  endDate: string | null;
  nextRelease: string | null;
  season: string | null;
  year: number | null;
  studios: string[];
  trailerId: string | null;
  sourceUrl: string;
}
export interface Episode {
  id: string;
  number: number;
  title: string;
  synopsis: string;
  airDate: string | null;
  length: number | null;
}
export type DiscoveryQuery = {
  q?: string;
  view?: string;
  page?: number;
  genre?: string;
  year?: number;
  season?: string;
};
const DAY = 86_400_000;
const fallbackImage = '/images/editorial/next-chapter-landscape.webp';
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const plain = (value: unknown) =>
  string(value)
    .replace(/<[^>]*>/g, '')
    .trim();
const positive = (value: unknown): number | null => {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
};
const imageUrl = (value: unknown): string | null => {
  try {
    const url = new URL(string(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};
const dateOnly = (value: unknown): string | null => {
  const text = string(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
};
const seasonOf = (date: string | null) =>
  date
    ? ['winter', 'spring', 'summer', 'fall'][Math.floor((Number(date.slice(5, 7)) - 1) / 3)]
    : null;
const resources = (doc: Document) => (Array.isArray(doc.data) ? doc.data : [doc.data]);

export function normalizeAnime(item: Resource, included: Resource[] = []): ProviderAnime {
  if (!item?.id || !item.attributes)
    throw new AppError(
      502,
      'INVALID_PROVIDER_RESPONSE',
      'Anime information is temporarily unavailable.'
    );
  const a = item.attributes;
  const categoryIds = new Set(
    (Array.isArray(item.relationships?.categories?.data)
      ? item.relationships.categories.data
      : []
    ).map((x) => x.id)
  );
  const categories = included.filter((x) => x.type === 'categories' && categoryIds.has(x.id));
  const broadGenres = new Set([
    'action',
    'adventure',
    'comedy',
    'drama',
    'fantasy',
    'romance',
    'science-fiction',
    'slice-of-life',
    'sports',
    'supernatural'
  ]);
  categories.sort(
    (a, b) =>
      Number(!broadGenres.has(a.attributes.slug)) - Number(!broadGenres.has(b.attributes.slug))
  );
  const producers = included.filter((x) => x.type === 'producers');
  const productionIds = new Set(
    included
      .filter((x) => x.type === 'animeProductions' && x.attributes?.role === 'studio')
      .flatMap((x) => {
        const producer = x.relationships?.producer?.data;
        return producer && !Array.isArray(producer) ? [producer.id] : [];
      })
  );
  const titles = Object.values(a.titles || {}).filter(
    (x): x is string => typeof x === 'string' && Boolean(x)
  );
  const title =
    plain(a.titles?.en || a.titles?.en_us || a.canonicalTitle || a.titles?.en_jp) ||
    'Untitled anime';
  const startDate = dateOnly(a.startDate);
  const score = positive(a.averageRating);
  const episodes = positive(a.episodeCount);
  return {
    externalId: String(item.id),
    provider: 'KITSU',
    title,
    alternativeTitles: [
      ...new Set([
        ...titles,
        ...(Array.isArray(a.abbreviatedTitles)
          ? a.abbreviatedTitles.filter((x: unknown) => typeof x === 'string')
          : [])
      ])
    ].filter((x) => x !== title),
    image:
      imageUrl(a.posterImage?.large || a.posterImage?.original || a.posterImage?.medium) ||
      fallbackImage,
    banner: imageUrl(a.coverImage?.large || a.coverImage?.original),
    synopsis: plain(a.synopsis || a.description),
    genres: categories
      .map((x) => (x.attributes.slug === 'science-fiction' ? 'Sci-Fi' : plain(x.attributes.title)))
      .filter(Boolean),
    categorySlugs: categories.map((x) => string(x.attributes.slug)).filter(Boolean),
    totalEpisodes:
      episodes !== null && Number.isInteger(episodes) && episodes <= 50000 ? episodes : null,
    episodeLength: positive(a.episodeLength),
    communityScore: score ? Math.min(10, score / 10) : null,
    popularityRank: positive(a.popularityRank),
    format: plain(a.subtype).toUpperCase(),
    airingStatus: plain(a.status),
    startDate,
    endDate: dateOnly(a.endDate),
    nextRelease:
      a.nextRelease && !Number.isNaN(Date.parse(a.nextRelease)) ? String(a.nextRelease) : null,
    season: seasonOf(startDate),
    year: startDate ? Number(startDate.slice(0, 4)) : null,
    studios: producers
      .filter((x) => productionIds.has(x.id))
      .map((x) => plain(x.attributes.name))
      .filter(Boolean),
    trailerId: /^[\w-]{11}$/.test(string(a.youtubeVideoId)) ? a.youtubeVideoId : null,
    sourceUrl: `https://kitsu.app/anime/${encodeURIComponent(string(a.slug) || String(item.id))}`
  };
}

export function createAnimeProvider(fetcher: typeof fetch = fetch, now = () => Date.now()) {
  const cache = new Map<string, { value: Document; until: number }>();
  const pending = new Map<string, Promise<Document>>();
  async function request(
    path: string,
    params: Record<string, string> = {},
    ttl = 10 * 60_000
  ): Promise<Document> {
    const url = new URL(`https://kitsu.io/api/edge${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const key = url.href;
    const cached = cache.get(key);
    if (cached && cached.until > now()) return cached.value;
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const response = await fetcher(url.href, {
          headers: { Accept: 'application/vnd.api+json' },
          signal: AbortSignal.timeout(8000)
        });
        if (response.status === 404)
          throw new AppError(
            404,
            'ANIME_NOT_FOUND',
            'This anime is no longer available from the provider.'
          );
        if (!response.ok)
          throw new AppError(
            503,
            'PROVIDER_UNAVAILABLE',
            response.status === 429
              ? 'Anime discovery is busy. Please try again shortly.'
              : 'Anime discovery is temporarily unavailable. Your saved collection is still available.'
          );
        const value = (await response.json()) as Document;
        if (!value || !value.data || (!Array.isArray(value.data) && typeof value.data !== 'object'))
          throw new Error('Invalid provider document');
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(key, { value, until: now() + ttl });
        return value;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'PROVIDER_UNAVAILABLE',
          'Cannot reach anime discovery right now. Your saved collection is still available.'
        );
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, promise);
    return promise;
  }
  async function search(query: DiscoveryQuery = {}) {
    const page = query.page || 1;
    const params: Record<string, string> = {
      'page[limit]': '12',
      'page[offset]': String((page - 1) * 12),
      include: 'categories'
    };
    if (query.q) params['filter[text]'] = query.q;
    if (query.genre)
      params['filter[categories]'] =
        query.genre === 'Sci-Fi'
          ? 'science-fiction'
          : query.genre.toLowerCase().replaceAll(' ', '-');
    params.sort = query.view === 'top' ? '-averageRating' : 'popularityRank';
    if (!query.q && query.view === 'seasonal') {
      params['filter[seasonYear]'] = String(query.year || new Date(now()).getUTCFullYear());
      params['filter[season]'] =
        query.season || seasonOf(new Date(now()).toISOString().slice(0, 10))!;
    }
    if (!query.q && query.view === 'upcoming') {
      params['filter[status]'] = 'upcoming';
      params.sort = 'startDate';
    }
    const doc = await request('/anime', params);
    return {
      items: resources(doc).map((x) => normalizeAnime(x, doc.included)),
      page,
      hasNext: Boolean(doc.links?.next),
      total: doc.meta?.count ?? null,
      source: 'Kitsu'
    };
  }
  async function get(id: string) {
    const doc = await request(
      `/anime/${id}`,
      { include: 'categories,animeProductions.producer' },
      6 * 60 * 60_000
    );
    if (Array.isArray(doc.data))
      throw new AppError(
        502,
        'INVALID_PROVIDER_RESPONSE',
        'Anime information is temporarily unavailable.'
      );
    return normalizeAnime(doc.data, doc.included);
  }
  async function episodes(id: string, page = 1) {
    const doc = await request(
      `/anime/${id}/episodes`,
      { 'page[limit]': '20', 'page[offset]': String((page - 1) * 20) },
      60 * 60_000
    );
    const items: Episode[] = resources(doc)
      .map((item) => ({
        id: item.id,
        number: Number(item.attributes.number),
        title:
          plain(
            item.attributes.canonicalTitle ||
              item.attributes.titles?.en ||
              item.attributes.titles?.en_jp
          ) || `Episode ${item.attributes.number}`,
        synopsis: plain(item.attributes.synopsis),
        airDate: dateOnly(item.attributes.airdate),
        length: positive(item.attributes.length)
      }))
      .filter((item) => Number.isInteger(item.number) && item.number > 0);
    return { items, page, hasNext: Boolean(doc.links?.next), total: doc.meta?.count ?? null };
  }
  async function relations(id: string) {
    const doc = await request(
      `/anime/${id}/media-relationships`,
      { include: 'destination', 'page[limit]': '20' },
      DAY
    );
    const items = resources(doc).flatMap((relation) => {
      const destination = relation.relationships?.destination?.data;
      if (!destination || Array.isArray(destination) || destination.type !== 'anime') return [];
      const anime = doc.included?.find((x) => x.type === 'anime' && x.id === destination.id);
      return anime
        ? [
            {
              ...normalizeAnime(anime, doc.included),
              relation: plain(relation.attributes.role).replaceAll('_', ' ')
            }
          ]
        : [];
    });
    return { items };
  }
  async function similar(id: string) {
    const anime = await get(id);
    const preferred = [
      'fantasy',
      'adventure',
      'drama',
      'comedy',
      'romance',
      'action',
      'science-fiction',
      'slice-of-life',
      'sports',
      'supernatural'
    ];
    const category =
      anime.categorySlugs.find((slug) => preferred.includes(slug)) || anime.categorySlugs[0];
    if (!category)
      return { items: [], explanation: 'No matching genres are available for this title.' };
    const doc = await request('/anime', {
      'filter[categories]': category,
      sort: '-averageRating',
      include: 'categories',
      'page[limit]': '12'
    });
    return {
      items: resources(doc)
        .filter((x) => x.id !== id)
        .map((x) => normalizeAnime(x, doc.included))
        .slice(0, 8),
      explanation: `Titles sharing the ${category.replaceAll('-', ' ')} category, ordered by community rating.`
    };
  }
  return { search, get, episodes, relations, similar };
}
export type AnimeProvider = ReturnType<typeof createAnimeProvider>;
