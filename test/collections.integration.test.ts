import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { testConfig } from './helpers.js';

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Private collections in isolated PostgreSQL', () => {
  const db = new PrismaClient({ datasourceUrl: connection });
  const app = createApp(db, testConfig);
  const emails = [0, 1].map(() => `temporary-collections-${randomUUID()}@example.test`);
  afterAll(async () => { await db.user.deleteMany({ where: { email: { in: emails } } }); await db.$disconnect(); });
  it('isolates owners, shares saved titles between groups, orders atomically and preserves watchlists', async () => {
    const tokens: string[] = [];
    for (const email of emails) {
      const response = await request(app).post('/api/auth/register').send({ email, name: 'Collections tester', password: 'temporary-collections-password-1928' }).expect(201);
      await db.user.update({ where: { id: response.body.user.id }, data: { emailVerifiedAt: new Date() } });
      tokens.push(response.body.accessToken);
    }
    const own = tokens[0]!;
    const other = tokens[1]!;
    const createEntry = async (token: string, title: string) => (await request(app).post('/api/watchlist').auth(token, { type: 'bearer' }).send({ title, genre: 'Adventure' }).expect(201)).body.item.id as string;
    const first = await createEntry(own, 'First temporary anime');
    const second = await createEntry(own, 'Second temporary anime');
    const foreign = await createEntry(other, 'Foreign temporary anime');
    const createGroup = async (name: string) => (await request(app).post('/api/collections').auth(own, { type: 'bearer' }).send({ name }).expect(201)).body.item.id as string;
    const group = await createGroup('Worlds to revisit');
    const another = await createGroup('Weekend watches');
    await request(app).get('/api/collections').expect(401);
    for (const method of ['get', 'patch', 'delete'] as const) {
      await request(app)[method](`/api/collections/${group}`).auth(other, { type: 'bearer' }).send({ name: 'Stolen' }).expect(404);
    }
    await request(app).post(`/api/collections/${group}/items`).auth(own, { type: 'bearer' }).send({ entryIds: [foreign] }).expect(404);
    await request(app).post(`/api/collections/${group}/items`).auth(other, { type: 'bearer' }).send({ entryIds: [foreign] }).expect(404);
    await request(app).post(`/api/collections/${group}/items`).auth(own, { type: 'bearer' }).send({ entryIds: [first, second, first] }).expect(204);
    await request(app).post(`/api/collections/${another}/items`).auth(own, { type: 'bearer' }).send({ entryIds: [first] }).expect(204);
    await request(app).put(`/api/collections/${group}/order`).auth(own, { type: 'bearer' }).send({ entryIds: [second, first] }).expect(204);
    const detail = await request(app).get(`/api/collections/${group}`).auth(own, { type: 'bearer' }).expect(200);
    expect(detail.body.item.items.map((item: { id: string }) => item.id)).toEqual([second, first]);
    await request(app).put(`/api/collections/${group}/order`).auth(own, { type: 'bearer' }).send({ entryIds: [first, first] }).expect(409);
    const list = await request(app).get('/api/collections').auth(other, { type: 'bearer' }).expect(200);
    expect(list.body.items).toEqual([]);
    await request(app).delete(`/api/collections/${group}`).auth(own, { type: 'bearer' }).expect(204);
    expect(await db.watchlistEntry.count({ where: { id: { in: [first, second] } } })).toBe(2);
    expect(await db.collectionItem.count({ where: { collectionId: another } })).toBe(1);
    await db.watchlistEntry.delete({ where: { id: first } });
    expect(await db.collectionItem.count({ where: { collectionId: another } })).toBe(0);
  }, 120000);
});
