import type { CookieOptions, RequestHandler } from 'express';
import type { AuthService } from '../services/auth.service.js';
import type { Config } from '../config.js';
import type { PrismaClient } from '@prisma/client';
import type { AuthRequest } from '../middleware/auth.js';
import { loginSchema, registerSchema } from '../validation.js';
import { publicUserSelect } from '../services/auth.service.js';
import { AppError } from '../errors.js';
import type { AccountService } from '../services/account.service.js';

export const cookieName = 'anitrack_refresh';
export function createAuthController(service: AuthService, db: PrismaClient, config: Config, account: AccountService, emailAvailable: boolean) {
  const options: CookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth'
  };
  const sendSession = (
    res: Parameters<RequestHandler>[1],
    result: Awaited<ReturnType<AuthService['login']>> & { verificationEmailSent?: boolean },
    status = 200
  ) => {
    res.cookie(cookieName, result.refreshToken, { ...options, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.status(status).json({ user: result.user, accessToken: result.accessToken,
      ...(result.verificationEmailSent !== undefined ? { verificationEmailSent: result.verificationEmailSent } : {}) });
  };
  return {
    register: (async (req, res) => {
      const result = await service.register(registerSchema.parse(req.body));
      let verificationEmailSent = false;
      if (emailAvailable) {
        try { verificationEmailSent = await account.requestVerification(result.user.id); }
        catch { console.warn('Registration verification email delivery failed'); }
      }
      // This session can only check verification, resend mail, or manage account recovery.
      sendSession(res, { ...result, verificationEmailSent }, 201);
    }) as RequestHandler,
    login: (async (req, res) =>
      sendSession(res, await service.login(loginSchema.parse(req.body)))) as RequestHandler,
    refresh: (async (req, res, next) => {
      // A new guest has no session to rotate. Invalid existing credentials still return 401.
      if (!req.cookies[cookieName]) {
        res.status(204).end();
        return;
      }
      try {
        sendSession(res, await service.refresh(req.cookies[cookieName]));
      } catch (error) {
        // A database outage must not erase a valid refresh credential.
        if (error instanceof AppError && error.status === 401) res.clearCookie(cookieName, options);
        next(error);
      }
    }) as RequestHandler,
    logout: (async (req, res) => {
      await service.logout(req.cookies[cookieName]);
      res.clearCookie(cookieName, options);
      res.status(204).end();
    }) as RequestHandler,
    me: (async (req, res) =>
      res.json({
        user: await db.user.findUniqueOrThrow({
          where: { id: (req as AuthRequest).user.id },
          select: publicUserSelect
        })
      })) as RequestHandler
  };
}
