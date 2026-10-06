import type { Request, RequestHandler } from 'express';
import type { PrismaClient, Role } from '@prisma/client';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { isTrustedOrigin } from '../origin.js';

export type AuthRequest = Request & { user: { id: string; role: Role }; sessionId: string };

export function requireAuth(db: PrismaClient, config: Config): RequestHandler {
  return async (req, _res, next) => {
    try {
      const bearer = req.headers.authorization;
      if (!bearer?.startsWith('Bearer '))
        throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
      let payload;
      try {
        payload = jwt.verify(bearer.slice(7), config.JWT_SECRET, {
          algorithms: ['HS256'],
          issuer: 'anitrack-api',
          audience: 'anitrack-client'
        });
      } catch {
        throw new AppError(401, 'INVALID_TOKEN', 'Your session has expired.');
      }
      if (typeof payload === 'string' || !payload.sub || typeof payload.sid !== 'string')
        throw new AppError(401, 'INVALID_TOKEN', 'Invalid session.');
      const session = await db.refreshSession.findUnique({
        where: { id: payload.sid },
        include: { user: { select: { id: true, role: true } } }
      });
      if (
        !session ||
        session.userId !== payload.sub ||
        session.revokedAt ||
        session.expiresAt <= new Date()
      )
        throw new AppError(401, 'SESSION_EXPIRED', 'Please sign in again.');
      (req as AuthRequest).user = session.user;
      (req as AuthRequest).sessionId = session.id;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if ((req as AuthRequest).user.role !== 'ADMIN')
    return next(new AppError(403, 'FORBIDDEN', 'Administrator access required.'));
  next();
};

export function requireTrustedOrigin(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !isTrustedOrigin(origin, config))
      return next(new AppError(403, 'UNTRUSTED_ORIGIN', 'Request origin is not allowed.'));
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return next(new AppError(403, 'UNTRUSTED_ORIGIN', 'Cross-site requests are not allowed.'));
    next();
  };
}
