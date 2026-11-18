import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AuthRequest } from '../src/middleware/auth.js';
import { assistantRouter } from '../src/routes/assistant.js';
import { testConfig } from './helpers.js';

describe('Assistant account rate limit', () => {
  it('limits an individual account without blocking classmates on the same IP', async () => {
    const interpreter = { plan: vi.fn().mockResolvedValue({ relevant: false, summary: '', question: 'Which anime?',
      titles: [], genres: [], excludeGenres: [], maxEpisodes: null, completedOnly: false, format: 'any' }), rank: vi.fn() };
    const app = express().use(express.json()).use((req, _res, next) => {
      // Test identity double; production requireAuth supplies the verified account ID.
      (req as AuthRequest).user = { id: String(req.headers['test-account']), role: 'MEMBER', emailVerifiedAt: new Date() };
      next();
    }).use('/assistant', assistantRouter(testConfig, { search: vi.fn() }, interpreter));
    const call = (account: string) => request(app).post('/assistant').set('test-account', account)
      .send({ mode: 'recommend', message: 'Adventure' });
    for (let i = 0; i < 12; i++) expect((await call('account-a')).status).toBe(200);
    const limited = await call('account-a');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('ASSISTANT_RATE_LIMITED');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect((await call('account-b')).status).toBe(200);
    expect(interpreter.plan).toHaveBeenCalledTimes(13);
  });
});
