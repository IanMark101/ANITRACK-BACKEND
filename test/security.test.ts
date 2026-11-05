import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { assistantInput } from '../src/services/anime-assistant.js';
import { testConfig, testDatabase } from './helpers.js';

describe('Request resource boundaries', () => {
  it('rejects compressed JSON before decompression', async () => {
    const app = createApp(testDatabase().db, testConfig);
    const result = await request(app).post('/api/auth/login')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'gzip')
      .send(gzipSync(JSON.stringify({ email: 'unused@example.test', password: 'unused' })));
    expect(result.status).toBe(415);
    expect(result.body.error.code).toBe('UNSUPPORTED_ENCODING');
  });
  it('rejects oversized arrays without validating each element', () => {
    const result = assistantInput.safeParse({ mode: 'identify', message: 'anime clue', excludeIds: Array(10000).fill(0) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });
  it('bounds collection membership input before per-title validation', async () => {
    const database = testDatabase();
    const app = createApp(database.db, testConfig);
    const registered = await request(app).post('/api/auth/register').send({ name: 'Boundary tester', email: 'boundary@example.test', password: 'boundary-test-password' }).expect(201);
    database.users[0].emailVerifiedAt = new Date();
    const result = await request(app).post('/api/collections/unused/items')
      .auth(registered.body.accessToken, { type: 'bearer' }).send({ entryIds: Array(10000).fill({}) });
    expect(result.status).toBe(400);
    expect(result.body.error.details).toHaveLength(1);
  });
});
