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
  TRUST_PROXY: '0'
};

// Test-only database double. Production always uses the PostgreSQL Prisma client.
export function testDatabase() {
  const users: any[] = [];
  const sessions: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
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
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        users.push(user);
        return project(user, select);
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
  return { db: db as PrismaClient, users, sessions };
}
