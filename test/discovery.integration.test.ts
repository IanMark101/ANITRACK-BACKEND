import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { testConfig } from './helpers.js';

dotenv.config({ path: '.integration.env', quiet: true });
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Imported anime and progress in isolated PostgreSQL', () => {
  const db = new PrismaClient({ datasourceUrl: connection });
  const id = '98765432';
  const suffix = randomUUID();
  const emails = [`discovery-${suffix}@example.test`, `ownership-${suffix}@example.test`];
  const anime = {
    id,
    type: 'anime',
    attributes: {
      canonicalTitle: 'Integration anime',
      synopsis: 'A test story',
      posterImage: { large: 'https://example.test/poster.jpg' },
      episodeCount: 3,
      averageRating: '97',
      status: 'current'
    },
    relationships: { categories: { data: [{ id: '1', type: 'categories' }] } }
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes('/episodes')
              ? {
                  data: [
                    {
                      id: 'ep1',
                      type: 'episodes',
                      attributes: {
                        number: 1,
                        canonicalTitle: 'First episode',
                        airdate: '2026-10-26'
                      }
                    }
                  ],
                  meta: { count: 1 }
                }
              : {
                  data: anime,
                  included: [
                    {
                      id: '1',
                      type: 'categories',
                      attributes: { title: 'Fantasy', slug: 'fantasy' }
                    }
                  ]
                }
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.anime.deleteMany({ where: { provider: 'KITSU', externalId: id } });
    await db.$disconnect();
  });
  it('imports once, separates personal ratings, enforces ownership, persists progress and survives provider downtime', async () => {
    vi.stubGlobal('fetch', fetcher);
    const app = createApp(db, testConfig);
    const signup = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Discovery fan',
        email: emails[0],
        password: 'integration-discovery-password-903'
      });
    const other = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Other fan',
        email: emails[1],
        password: 'integration-discovery-password-903'
      });
    expect(signup.status).toBe(201);
    expect(other.status).toBe(201);
    await db.user.updateMany({ where: { id: { in: [signup.body.user.id, other.body.user.id] } }, data: { emailVerifiedAt: new Date() } });
    const token = signup.body.accessToken;
    const imported = await request(app)
      .post('/api/watchlist/import')
      .auth(token, { type: 'bearer' })
      .send({ externalId: id });
    expect(imported.status).toBe(201);
    expect(imported.body.item).toMatchObject({
      provider: 'KITSU',
      externalId: id,
      totalEpisodes: 3,
      episodesWatched: 0,
      rating: 8.5
    });
    const entryId = imported.body.item.id;
    const repeat = await request(app)
      .post('/api/watchlist/import')
      .auth(token, { type: 'bearer' })
      .send({ externalId: id });
    expect(repeat.status).toBe(200);
    expect(repeat.body.item.id).toBe(entryId);
    expect(await db.watchlistEntry.count({ where: { userId: signup.body.user.id } })).toBe(1);
    expect(
      (
        await request(app)
          .post(`/api/watchlist/${entryId}/progress`)
          .auth(other.body.accessToken, { type: 'bearer' })
          .send({ delta: 1 })
      ).status
    ).toBe(404);
    const initial = await request(app)
      .patch(`/api/watchlist/${entryId}`)
      .auth(token, { type: 'bearer' })
      .send({ episodesWatched: 2, rating: 9.1 });
    expect(initial.body.item).toMatchObject({
      episodesWatched: 2,
      status: 'Watching',
      rating: 9.1
    });
    const complete = await request(app)
      .post(`/api/watchlist/${entryId}/progress`)
      .auth(token, { type: 'bearer' })
      .send({ delta: 1 });
    expect(complete.body.item).toMatchObject({
      episodesWatched: 3,
      status: 'Completed',
      rating: 9.1
    });
    expect(
      (
        await request(app)
          .post(`/api/watchlist/${entryId}/progress`)
          .auth(token, { type: 'bearer' })
          .send({ delta: 1 })
      ).status
    ).toBe(400);
    await request(app)
      .patch(`/api/watchlist/${entryId}`)
      .auth(token, { type: 'bearer' })
      .send({ episodesWatched: 0 });
    const simultaneous = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post(`/api/watchlist/${entryId}/progress`)
          .auth(token, { type: 'bearer' })
          .send({ delta: 1 })
      )
    );
    expect(simultaneous.map((response) => response.status)).toEqual([200, 200]);
    const persisted = await db.watchlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(persisted.episodesWatched).toBe(2);
    const calendar = await request(app)
      .get('/api/watchlist/calendar?week=2026-10-26')
      .auth(token, { type: 'bearer' });
    expect(calendar.status).toBe(200);
    expect(calendar.body.events).toHaveLength(1);
    expect(calendar.body.events[0]).toMatchObject({
      episode: 1,
      date: '2026-10-26',
      externalId: id
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Provider offline')));
    const restarted = createApp(db, testConfig);
    const collection = await request(restarted)
      .get('/api/watchlist')
      .auth(token, { type: 'bearer' });
    expect(collection.status).toBe(200);
    expect(collection.body.items[0]).toMatchObject({ id: entryId, episodesWatched: 2 });
    const details = await request(restarted).get(`/api/discovery/${id}`).auth(token, { type: 'bearer' });
    expect(details.status).toBe(200);
    expect(details.body.stale).toBe(true);
    expect(details.body.item.title).toBe('Integration anime');
    const offlineImport = await request(restarted)
      .post('/api/watchlist/import')
      .auth(token, { type: 'bearer' })
      .send({ externalId: id });
    expect(offlineImport.status).toBe(200);
    expect(offlineImport.body.item.id).toBe(entryId);
  }, 120000);
});
