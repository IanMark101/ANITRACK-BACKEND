import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { testConfig, testDatabase } from './helpers.js';
import type { AccountMailer } from '../src/services/mail.service.js';

afterEach(() => vi.unstubAllGlobals());
describe('Required email verification', () => {
  const input = { name: 'Verification tester', email: 'verification@example.test', password: 'temporary-verification-password' };
  it('sends verification on signup and blocks every workspace route until a real token is consumed', async () => {
    const database = testDatabase();
    const deliveries: string[] = [];
    const mailer: AccountMailer = { available: true, async send(_email, purpose, token) { expect(purpose).toBe('EMAIL_VERIFICATION'); deliveries.push(token); } };
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const app = createApp(database.db, testConfig, { accountMailer: mailer });
    const signup = await request(app).post('/api/auth/register').send(input).expect(201);
    expect(signup.body.user.emailVerifiedAt).toBeNull();
    expect(signup.body.verificationEmailSent).toBe(true);
    expect(deliveries).toHaveLength(1);
    const token = signup.body.accessToken;
    for (const path of ['/api/watchlist', '/api/watchlist/calendar', '/api/collections', '/api/anime', '/api/anime/meta', '/api/anime/example', '/api/discovery', '/api/discovery/123', '/api/discovery/123/episodes', '/api/discovery/123/related', '/api/discovery/123/similar', '/api/admin/usage', '/api/admin/metrics']) {
      const result = await request(app).get(path).auth(token, { type: 'bearer' }).expect(403);
      expect(result.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    }
    for (const path of ['/api/assistant', '/api/watchlist', '/api/watchlist/import', '/api/collections'])
      await request(app).post(path).auth(token, { type: 'bearer' }).send({}).expect(403);
    expect(fetcher).not.toHaveBeenCalled();
    await request(app).get('/api/auth/me').auth(token, { type: 'bearer' }).expect(200);
    await request(app).post('/api/auth/email/request').auth(token, { type: 'bearer' }).expect(429);
    expect(deliveries).toHaveLength(1);
    await request(app).post('/api/auth/email/verify').send({ token: 'x'.repeat(43) }).expect(400);
    await request(app).post('/api/auth/email/verify').send({ token: deliveries[0] }).expect(204);
    expect(database.users[0].emailVerifiedAt).toBeInstanceOf(Date);
    const alreadyVerified = await request(app).post('/api/auth/email/request').auth(token, { type: 'bearer' }).expect(200);
    expect(alreadyVerified.body.verificationEmailSent).toBe(false);
    expect(deliveries).toHaveLength(1);
    await request(app).post('/api/auth/email/verify').send({ token: deliveries[0] }).expect(400);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { count: 0 } }), { status: 200 }));
    await request(app).get('/api/discovery?q=Haikyu').auth(token, { type: 'bearer' }).expect(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps email delivery failures recoverable without granting access or claiming an email was sent', async () => {
    const database = testDatabase();
    const send = vi.fn().mockRejectedValueOnce(new Error('Private SMTP failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(database.db, testConfig, { accountMailer: { available: true, send } });
    try {
      const signup = await request(app).post('/api/auth/register').send(input).expect(201);
      expect(signup.body.verificationEmailSent).toBe(false);
      expect(database.accountTokens).toHaveLength(0);
      await request(app).get('/api/watchlist').auth(signup.body.accessToken, { type: 'bearer' }).expect(403);
      send.mockResolvedValueOnce(undefined);
      await request(app).post('/api/auth/email/request').auth(signup.body.accessToken, { type: 'bearer' }).expect(200);
      expect(send).toHaveBeenCalledTimes(2);
      expect(database.accountTokens).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('Registration verification email delivery failed');
    } finally { warn.mockRestore(); }
  });
  it('retains the verification restriction after login and cookie refresh', async () => {
    const app = createApp(testDatabase().db, testConfig);
    const signup = await request(app).post('/api/auth/register').send(input).expect(201);
    expect(signup.body.verificationEmailSent).toBe(false);
    const login = await request(app).post('/api/auth/login').send({ email: input.email, password: input.password }).expect(200);
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', login.headers['set-cookie']).expect(200);
    expect(refreshed.body.user.emailVerifiedAt).toBeNull();
    await request(app).get('/api/discovery').auth(refreshed.body.accessToken, { type: 'bearer' }).expect(403);
    await request(app).post('/api/auth/email/request').auth(refreshed.body.accessToken, { type: 'bearer' }).expect(503);
  });
});
