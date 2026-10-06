import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { testConfig } from './helpers.js';

dotenv.config({ path: '.integration.env', quiet: true });
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Real PostgreSQL authentication and watchlist', () => {
  const db = new PrismaClient({ datasourceUrl: connection });
  const app = createApp(db, testConfig);
  const suffix = randomUUID();
  const emails = [`integration-${suffix}@example.test`, `other-${suffix}@example.test`];
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.$disconnect();
  });

  it('persists entries, enforces ownership, rotates refresh tokens, and logs out', async () => {
    const account = {
      name: 'Integration fan',
      email: emails[0],
      password: 'test-account-password-9283'
    };
    const signup = await request(app).post('/api/auth/register').send(account);
    expect(signup.status).toBe(201);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: account.email, password: account.password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken;
    const empty = await request(app).get('/api/watchlist').auth(token, { type: 'bearer' });
    expect(empty.status).toBe(200);
    expect(empty.body.items).toHaveLength(0);
    const image = `data:image/webp;base64,${readFileSync(new URL('./fixtures/poster.webp', import.meta.url)).toString('base64')}`;
    const added = await request(app)
      .post('/api/watchlist')
      .set('Connection', 'keep-alive')
      .auth(token, { type: 'bearer' })
      .send({
        title: 'Integration custom anime',
        genre: 'Adventure',
        image,
        rating: 9.2,
        status: 'Watching'
      });
    expect(added.status).toBe(201);
    expect(added.body.item.image).toBe(image);
    const id = added.body.item.id;
    const other = await request(app)
      .post('/api/auth/register')
      .send({ ...account, email: emails[1] });
    expect(
      (
        await request(app)
          .patch(`/api/watchlist/${id}`)
          .auth(other.body.accessToken, { type: 'bearer' })
          .send({ rating: 1 })
      ).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .put('/api/watchlist/spotlight')
          .auth(other.body.accessToken, { type: 'bearer' })
          .send({ entryId: id })
      ).status
    ).toBe(404);
    const update = await request(app)
      .patch(`/api/watchlist/${id}`)
      .set('Connection', 'keep-alive')
      .auth(token, { type: 'bearer' })
      .send({ rating: 9.7, isFavorite: true, status: 'Completed' });
    expect(update.status).toBe(200);
    const ratingOnly = await request(app)
      .patch(`/api/watchlist/${id}`)
      .set('Connection', 'keep-alive')
      .auth(token, { type: 'bearer' })
      .send({ rating: 9.4 });
    expect(ratingOnly.body.item).toMatchObject({
      rating: 9.4,
      status: 'Completed',
      isFavorite: true
    });
    const favoriteOnly = await request(app)
      .patch(`/api/watchlist/${id}`)
      .set('Connection', 'keep-alive')
      .auth(token, { type: 'bearer' })
      .send({ isFavorite: false });
    expect(favoriteOnly.body.item).toMatchObject({
      rating: 9.4,
      status: 'Completed',
      isFavorite: false
    });
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie']);
    expect(refresh.status).toBe(200);
    const restored = await request(app)
      .get('/api/watchlist')
      .set('Connection', 'keep-alive')
      .auth(refresh.body.accessToken, { type: 'bearer' });
    expect(restored.status).toBe(200);
    expect(restored.body.items[0]).toMatchObject({
      id,
      image,
      rating: 9.4,
      isFavorite: false,
      status: 'Completed'
    });
    expect(
      (
        await request(app)
          .delete(`/api/watchlist/${id}`)
          .auth(other.body.accessToken, { type: 'bearer' })
      ).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/api/watchlist/${id}`)
          .auth(refresh.body.accessToken, { type: 'bearer' })
      ).status
    ).toBe(204);
    expect(await db.anime.count({ where: { ownerId: signup.body.user.id } })).toBe(0);
    expect(
      (await request(app).post('/api/auth/logout').set('Cookie', refresh.headers['set-cookie']))
        .status
    ).toBe(204);
    expect(
      (await request(app).get('/api/auth/me').auth(refresh.body.accessToken, { type: 'bearer' }))
        .status
    ).toBe(401);
  }, 20000);
});
