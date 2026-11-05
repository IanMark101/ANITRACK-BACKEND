import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { testConfig, testDatabase } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());
describe('All application features require authentication', () => {
  it('rejects guests before querying the catalog or calling Kitsu or Gemini', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const app = createApp(testDatabase().db, testConfig);
    for (const path of ['/api/anime', '/api/anime/meta', '/api/anime/example', '/api/discovery', '/api/discovery/123', '/api/discovery/123/episodes', '/api/discovery/123/related', '/api/discovery/123/similar']) {
      const response = await request(app).get(path).expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
    await request(app).post('/api/assistant').send({ mode: 'identify', message: 'A pirate in a straw hat' }).expect(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows signed-in discovery and assistant validation, then rejects the revoked session', async () => {
    const database = testDatabase();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { count: 0 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const app = createApp(database.db, testConfig);
    const signup = await request(app).post('/api/auth/register').send({ name: 'Private feature tester', email: 'private-feature@example.test', password: 'private-feature-password' }).expect(201);
    const token = signup.body.accessToken;
    database.users[0].emailVerifiedAt = new Date();
    const discovery = await request(app).get('/api/discovery?q=Haikyu').auth(token, { type: 'bearer' }).expect(200);
    expect(discovery.body.items).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    await request(app).post('/api/assistant').auth(token, { type: 'bearer' }).send({ mode: 'identify', message: '' }).expect(400);
    database.sessions[0].revokedAt = new Date();
    await request(app).get('/api/discovery').auth(token, { type: 'bearer' }).expect(401);
    await request(app).post('/api/assistant').auth(token, { type: 'bearer' }).send({ mode: 'identify', message: 'A pirate' }).expect(401);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
