import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { createAccountService } from '../services/account.service.js';
import { createAccountMailer, type AccountMailer } from '../services/mail.service.js';
import { cookieName } from '../controllers/auth.controller.js';
import { accountTokenSchema, changePasswordSchema, deleteAccountSchema, emailRequestSchema, resetPasswordSchema, updateProfileSchema } from '../validation.js';

export function accountRouter(db: PrismaClient, config: Config, limit: RequestHandler,
  mailer: AccountMailer = createAccountMailer(config)) {
  const router = Router();
  const account = createAccountService(db, mailer);
  const protect = requireAuth(db, config);
  const pending = requireAuth(db, config, { allowUnverified: true });
  const userId = (req: Parameters<RequestHandler>[0]) => (req as AuthRequest).user.id;
  const clear = (res: Parameters<RequestHandler>[1]) => res.clearCookie(cookieName, {
    httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/api/auth'
  });
  router.post('/auth/password/forgot', limit, async (req, res) => {
    await account.requestReset(emailRequestSchema.parse(req.body).email);
    res.json({ message: 'If an account matches that email, a password-reset link will be sent.' });
  });
  router.post('/auth/password/reset', limit, async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);
    await account.consume(input.token, 'PASSWORD_RESET', input.password);
    clear(res);
    res.status(204).end();
  });
  router.post('/auth/email/verify', limit, async (req, res) => {
    await account.consume(accountTokenSchema.parse(req.body).token, 'EMAIL_VERIFICATION');
    res.status(204).end();
  });
  router.post('/auth/email/request', limit, pending, async (req, res) => {
    const verificationEmailSent = await account.requestVerification(userId(req));
    res.json({ verificationEmailSent, message: verificationEmailSent ? 'A new verification link has been sent.' : 'Your email is already verified.' });
  });
  router.patch('/account', protect, async (req, res) => {
    res.json({ user: await account.updateProfile(userId(req), updateProfileSchema.parse(req.body).name) });
  });
  router.put('/account/password', limit, pending, async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    await account.changePassword(userId(req), input.currentPassword, input.password);
    clear(res);
    res.status(204).end();
  });
  router.delete('/account', limit, pending, async (req, res) => {
    const input = deleteAccountSchema.parse(req.body);
    await account.remove(userId(req), input.password);
    clear(res);
    res.status(204).end();
  });
  return router;
}
