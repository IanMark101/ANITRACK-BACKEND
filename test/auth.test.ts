import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { testConfig, testDatabase } from './helpers.js';

describe('Authentication API', () => {
  let database: ReturnType<typeof testDatabase>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    database = testDatabase();
    app = createApp(database.db, testConfig);
  });
  const account = {
    name: 'Mika Tanaka',
    email: 'mika@example.test',
    password: 'a-unique-password-483'
  };

  it('registers with a bcrypt hash and exposes only public user fields', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...account, email: ' MIKA@example.test ' });
    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('mika@example.test');
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('refreshToken');
    expect(await bcrypt.compare(account.password, database.users[0].passwordHash)).toBe(true);
    expect(database.sessions[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/auth');
  });

  it('sets a Secure refresh cookie in production', async () => {
    const production = createApp(database.db, {
      ...testConfig,
      NODE_ENV: 'production',
      CLIENT_ORIGIN: 'https://example.test'
    });
    const response = await request(production).post('/api/auth/register').send(account);
    expect(response.headers['set-cookie'][0]).toContain('Secure');
  });

  it('handles login, protected me, rotation, and immediate logout revocation', async () => {
    await request(app).post('/api/auth/register').send(account);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: account.email, password: account.password });
    expect(login.status).toBe(200);
    const me = await request(app)
      .get('/api/auth/me')
      .auth(login.body.accessToken, { type: 'bearer' });
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe(account.name);
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie'])
      .send();
    expect(refresh.status).toBe(200);
    expect(refresh.headers['set-cookie'][0]).not.toBe(login.headers['set-cookie'][0]);
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refresh.headers['set-cookie'])
      .send();
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(
      (await request(app).get('/api/auth/me').auth(refresh.body.accessToken, { type: 'bearer' }))
        .status
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/refresh')
          .set('Cookie', refresh.headers['set-cookie'])
          .send()
      ).status
    ).toBe(401);
  });

  it('revokes the token family if a consumed refresh token is replayed', async () => {
    const login = await request(app).post('/api/auth/register').send(account);
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie']);
    expect(refresh.status).toBe(200);
    expect(
      (await request(app).post('/api/auth/refresh').set('Cookie', login.headers['set-cookie']))
        .status
    ).toBe(401);
    expect(
      (await request(app).get('/api/auth/me').auth(refresh.body.accessToken, { type: 'bearer' }))
        .status
    ).toBe(401);
  });

  it('rejects duplicate accounts and wrong passwords without exposing the hash', async () => {
    await request(app).post('/api/auth/register').send(account);
    expect((await request(app).post('/api/auth/register').send(account)).status).toBe(409);
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: account.email, password: 'wrong password' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'unknown@example.test', password: 'wrong password' })
      ).status
    ).toBe(401);
  });

  it('rejects missing, forged, and expired access tokens', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').auth('forged', { type: 'bearer' })).status).toBe(
      401
    );
    const token = jwt.sign({ sub: 'user', sid: 'session' }, testConfig.JWT_SECRET, {
      expiresIn: -10,
      issuer: 'anitrack-api',
      audience: 'anitrack-client'
    });
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(
      401
    );
  });

  it('validates inputs and prevents client role escalation', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ ...account, role: 'ADMIN' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ ...account, password: 'short' })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ ...account, password: '文'.repeat(30) })
      ).status
    ).toBe(400);
    expect(database.users).toHaveLength(0);
  });

  it('rejects untrusted origins and cross-site requests', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .set('Origin', 'https://evil.example')
          .send(account)
      ).status
    ).toBe(403);
    expect(
      (await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site')).status
    ).toBe(403);
    expect(database.users).toHaveLength(0);
  });

  it('denies catalog writes to a member and protects watchlist routes', async () => {
    const login = await request(app).post('/api/auth/register').send(account);
    expect(
      (
        await request(app)
          .post('/api/anime')
          .auth(login.body.accessToken, { type: 'bearer' })
          .send({ title: 'Title' })
      ).status
    ).toBe(403);
    expect((await request(app).get('/api/watchlist')).status).toBe(401);
  });

  it('rate limits repeated authentication attempts', async () => {
    let response;
    for (let i = 0; i < 41; i++) response = await request(app).post('/api/auth/register').send({});
    expect(response?.status).toBe(429);
    expect(response?.body.error.code).toBe('RATE_LIMITED');
  });
});
