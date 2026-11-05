import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import { createAssistantBudget } from '../src/services/assistant-budget.js';
import type { AccountMailer } from '../src/services/mail.service.js';

dotenv.config({ path: '.integration.env', quiet: true });
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Account lifecycle in isolated PostgreSQL', () => {
  const db = new PrismaClient({ datasourceUrl: connection });
  const email = `temporary-review-${randomUUID()}@example.test`;
  const sent: { purpose: string; token: string }[] = [];
  const mailer: AccountMailer = { available: true, async send(_to, purpose, token) { sent.push({ purpose, token }); } };
  const app = createApp(db, testConfig, { accountMailer: mailer });
  afterAll(async () => {
    await db.user.deleteMany({ where: { email } });
    await db.assistantUsageDay.deleteMany({ where: { day: new Date('2099-01-01') } });
    await db.$disconnect();
  });
  it('creates a temporary account, verifies email, resets passwords once, revokes sessions and deletes private data', async () => {
    const initial = { name: 'Temporary review account', email, password: 'temporary-test-password-9182' };
    const signup = await request(app).post('/api/auth/register').send(initial).expect(201);
    const bearer = signup.body.accessToken;
    expect(signup.body.verificationEmailSent).toBe(true);
    for (const path of ['/api/watchlist', '/api/collections', '/api/anime/meta', '/api/discovery', '/api/watchlist/calendar']) {
      const denied = await request(app).get(path).auth(bearer, { type: 'bearer' }).expect(403);
      expect(denied.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    }
    await request(app).get('/api/auth/me').auth(bearer, { type: 'bearer' }).expect(200);
    await request(app).post('/api/auth/email/request').auth(bearer, { type: 'bearer' }).expect(429);
    const verifyToken = sent.find((mail) => mail.purpose === 'EMAIL_VERIFICATION')!.token;
    expect((await db.accountToken.findFirst({ where: { userId: signup.body.user.id } }))?.tokenHash).not.toBe(verifyToken);
    await request(app).post('/api/auth/email/verify').send({ token: verifyToken }).expect(204);
    await request(app).get('/api/watchlist').auth(bearer, { type: 'bearer' }).expect(200);
    await request(app).post('/api/auth/email/verify').send({ token: verifyToken }).expect(400);
    await request(app).patch('/api/account').auth(bearer, { type: 'bearer' }).send({ name: 'Updated review account' }).expect(200);
    await request(app).post('/api/auth/password/forgot').send({ email }).expect(200);
    await expect.poll(() => sent.some((mail) => mail.purpose === 'PASSWORD_RESET'), { timeout: 15000 }).toBe(true);
    const resetToken = sent.find((mail) => mail.purpose === 'PASSWORD_RESET')!.token;
    const reset = { token: resetToken, password: 'new-test-password-4817' };
    const attempts = await Promise.all([request(app).post('/api/auth/password/reset').send(reset), request(app).post('/api/auth/password/reset').send(reset)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([204, 400]);
    await request(app).get('/api/auth/me').auth(bearer, { type: 'bearer' }).expect(401);
    await request(app).post('/api/auth/login').send({ email, password: initial.password }).expect(401);
    const login = await request(app).post('/api/auth/login').send({ email, password: reset.password }).expect(200);
    expect(login.body.user.emailVerifiedAt).toBeTruthy();
    const token = login.body.accessToken;
    const created = await request(app).post('/api/watchlist').auth(token, { type: 'bearer' })
      .send({ title: 'Temporary private title', genre: 'Adventure' }).expect(201);
    await request(app).delete('/api/account').auth(token, { type: 'bearer' }).send({ password: 'incorrect', confirmation: 'DELETE' }).expect(400);
    await request(app).put('/api/account/password').auth(token, { type: 'bearer' })
      .send({ currentPassword: reset.password, password: 'final-test-password-4817' }).expect(204);
    await request(app).get('/api/auth/me').auth(token, { type: 'bearer' }).expect(401);
    const last = await request(app).post('/api/auth/login').send({ email, password: 'final-test-password-4817' }).expect(200);
    await request(app).delete('/api/account').auth(last.body.accessToken, { type: 'bearer' })
      .send({ password: 'final-test-password-4817', confirmation: 'DELETE' }).expect(204);
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.anime.count({ where: { id: created.body.item.animeId } })).toBe(0);
    expect(await db.refreshSession.count({ where: { userId: signup.body.user.id } })).toBe(0);
  }, 120000);
  it('enforces the daily generation limit across concurrent callers', async () => {
    const budget = createAssistantBudget(db, { ...testConfig, ASSISTANT_DAILY_GENERATIONS: 3 }, () => new Date('2099-01-01'));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.reserve(100, 100)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const record = await db.assistantUsageDay.findUniqueOrThrow({ where: { day: new Date('2099-01-01') } });
    expect(record.attempts).toBe(3);
    expect(record.reservedMicros).toBeGreaterThan(0);
  }, 120000);
  it('serializes verification resends, rejects expired links and preserves the usable link', async () => {
    const password = 'temporary-verification-password-6192';
    const signup = await request(app).post('/api/auth/register').send({ name: 'Verification retry tester', email, password }).expect(201);
    const token = signup.body.accessToken;
    const first = sent.at(-1)!.token;
    await db.accountToken.updateMany({ where: { userId: signup.body.user.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    const deliveries = sent.length;
    const attempts = await Promise.all(Array.from({ length: 3 }, () => request(app).post('/api/auth/email/request').auth(token, { type: 'bearer' })));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 429, 429]);
    expect(sent.length - deliveries).toBe(1);
    const latest = sent.at(-1)!.token;
    await db.accountToken.updateMany({ where: { userId: signup.body.user.id, createdAt: { lt: new Date(Date.now() - 60_000) } }, data: { expiresAt: new Date(Date.now() - 1) } });
    await request(app).post('/api/auth/email/verify').send({ token: first }).expect(400);
    await request(app).get('/api/watchlist').auth(token, { type: 'bearer' }).expect(403);
    await request(app).post('/api/auth/email/verify').send({ token: latest }).expect(204);
    await request(app).get('/api/watchlist').auth(token, { type: 'bearer' }).expect(200);
    expect(await db.accountToken.count({ where: { userId: signup.body.user.id } })).toBe(0);
    await request(app).delete('/api/account').auth(token, { type: 'bearer' }).send({ password, confirmation: 'DELETE' }).expect(204);
  }, 120000);
});
