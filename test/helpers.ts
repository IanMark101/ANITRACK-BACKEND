import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../src/config.js';

export const testConfig: Config = {
  DATABASE_URL: 'postgresql://test:unused@localhost/test',
  DIRECT_URL: 'postgresql://test:unused@localhost/test',
  JWT_SECRET: 'test-secret-for-auth-tests-at-least-32-characters',
  CLIENT_ORIGIN: 'http://localhost:5173',
  PORT: 3001,
  NODE_ENV: 'test',
  TRUST_PROXY: '0',
  SMTP_PORT: 587, SMTP_SECURE: '0', COLLECTION_LIMIT: 500,
  ASSISTANT_DAILY_GENERATIONS: 100, ASSISTANT_DAILY_BUDGET_USD: 5,
  ASSISTANT_INPUT_USD_PER_MILLION: 6, ASSISTANT_OUTPUT_USD_PER_MILLION: 30
};

// Test-only database double. Production always uses the PostgreSQL Prisma client.
export function testDatabase() {
  const users: any[] = [];
  const sessions: any[] = [];
  const accountTokens: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]: [string, any]) =>
      value && typeof value === 'object' && 'gt' in value ? row[key] > value.gt : row[key] === value);
  const project = (row: any, select: any) =>
    select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };
  const db: any = {
    user: {
      async findUnique({ where, select }: any) {
        const user = users.find((row) => matches(row, where));
        return user ? project(user, select) : null;
      },
      async findUniqueOrThrow(args: any) {
        const user = await db.user.findUnique(args);
        if (!user) throw new Error('Not found');
        return user;
      },
      async create({ data, select }: any) {
        const user = {
          id: randomUUID(),
          role: 'MEMBER',
          emailVerifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        users.push(user);
        return project(user, select);
      },
      async update({ where, data, select }: any) {
        const user = users.find(row => matches(row, where));
        if (!user) throw new Error('Not found');
        Object.assign(user, data);
        return project(user, select);
      }
    },
    accountToken: {
      async create({ data }: any) {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        accountTokens.push(row);
        return { ...row };
      },
      async findFirst({ where }: any) { return accountTokens.find(row => matches(row, where)) ?? null; },
      async findUnique({ where }: any) { return accountTokens.find(row => matches(row, where)) ?? null; },
      async deleteMany({ where }: any) {
        const found = accountTokens.filter(row => matches(row, where));
        for (const row of found) accountTokens.splice(accountTokens.indexOf(row), 1);
        return { count: found.length };
      }
    },
    refreshSession: {
      async create({ data }: any) {
        const session = { id: randomUUID(), revokedAt: null, createdAt: new Date(), ...data };
        sessions.push(session);
        return { ...session };
      },
      async findUnique({ where, include }: any) {
        const session = sessions.find((row) => matches(row, where));
        return session
          ? {
              ...session,
              ...(include
                ? {
                    user: project(
                      users.find((user) => user.id === session.userId),
                      include.user.select
                    )
                  }
                : {})
            }
          : null;
      },
      async updateMany({ where, data }: any) {
        const found = sessions.filter((row) => matches(row, where));
        found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }
    },
    async $transaction(callback: any) {
      return callback(db);
    }
  };
  return { db: db as PrismaClient, users, sessions, accountTokens };
}
