import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true
} as const;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const refreshLifetime = 30 * 24 * 60 * 60 * 1000;

export function createAuthService(db: PrismaClient, config: Config) {
  function accessToken(userId: string, sessionId: string) {
    return jwt.sign({ sid: sessionId }, config.JWT_SECRET, {
      subject: userId,
      issuer: 'anitrack-api',
      audience: 'anitrack-client',
      expiresIn: '15m',
      algorithm: 'HS256'
    });
  }

  async function issueSession(userId: string) {
    const token = randomBytes(48).toString('base64url');
    const session = await db.refreshSession.create({
      data: {
        userId,
        tokenHash: hash(token),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + refreshLifetime)
      }
    });
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: publicUserSelect
    });
    return { user, accessToken: accessToken(userId, session.id), refreshToken: token };
  }

  return {
    async register(input: { name: string; email: string; password: string }) {
      const existing = await db.user.findUnique({
        where: { email: input.email },
        select: { id: true }
      });
      if (existing)
        throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await db.user.create({
        data: { name: input.name, email: input.email, passwordHash },
        select: { id: true }
      });
      return issueSession(user.id);
    },
    async login(input: { email: string; password: string }) {
      const user = await db.user.findUnique({ where: { email: input.email } });
      // A valid bcrypt hash keeps the comparison expensive even for unknown emails.
      const valid = await bcrypt.compare(
        input.password,
        user?.passwordHash ?? '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6Ttxbm1DgCrDKwLNZlDNVBzp3Dn7m'
      );
      if (!user || !valid)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      return issueSession(user.id);
    },
    async refresh(token?: string) {
      if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
      const result = await db.$transaction(async (tx) => {
        const previous = await tx.refreshSession.findUnique({ where: { tokenHash: hash(token) } });
        if (!previous) return null;
        if (previous.revokedAt || previous.expiresAt <= new Date()) {
          await tx.refreshSession.updateMany({
            where: { familyId: previous.familyId, revokedAt: null },
            data: { revokedAt: new Date() }
          });
          return null;
        }
        // Conditional update makes simultaneous reuse fail atomically.
        const consumed = await tx.refreshSession.updateMany({
          where: { id: previous.id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        if (consumed.count !== 1) {
          await tx.refreshSession.updateMany({
            where: { familyId: previous.familyId, revokedAt: null },
            data: { revokedAt: new Date() }
          });
          return null;
        }
        const refreshToken = randomBytes(48).toString('base64url');
        const session = await tx.refreshSession.create({
          data: {
            userId: previous.userId,
            familyId: previous.familyId,
            tokenHash: hash(refreshToken),
            expiresAt: previous.expiresAt
          }
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { id: previous.userId },
          select: publicUserSelect
        });
        return { user, accessToken: accessToken(user.id, session.id), refreshToken };
      });
      if (!result)
        throw new AppError(
          401,
          'SESSION_EXPIRED',
          'Your session has expired. Please sign in again.'
        );
      return result;
    },
    async logout(token?: string) {
      if (!token) return;
      const session = await db.refreshSession.findUnique({ where: { tokenHash: hash(token) } });
      if (session)
        await db.refreshSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() }
        });
    }
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
