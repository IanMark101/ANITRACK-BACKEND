import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { AccountTokenPurpose, PrismaClient } from '@prisma/client';
import { AppError } from '../errors.js';
import { publicUserSelect } from './auth.service.js';
import type { AccountMailer } from './mail.service.js';
import { transactionOptions } from '../transaction-options.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createAccountService(db: PrismaClient, mailer: AccountMailer) {
  async function passwordMatches(userId: string, password: string) {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!await bcrypt.compare(password, user.passwordHash))
      throw new AppError(400, 'PASSWORD_INCORRECT', 'Your current password is incorrect.');
    return user;
  }
  async function issue(userId: string, email: string, purpose: AccountTokenPurpose) {
    const token = randomBytes(32).toString('base64url');
    // A valid previous link stays usable if delivery of a new link fails.
    const row = await db.accountToken.create({ data: { userId, purpose, tokenHash: hash(token),
      expiresAt: new Date(Date.now() + (purpose === 'PASSWORD_RESET' ? 30 * 60_000 : 86400_000)) } });
    try { await mailer.send(email, purpose, token); }
    catch (error) { await db.accountToken.deleteMany({ where: { id: row.id } }); throw error; }
  }
  return {
    async requestReset(email: string) {
      if (!mailer.available) throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Account email is not configured yet. Please try again later.');
      const user = await db.user.findUnique({ where: { email } });
      // Every existing/nonexisting address gets the same response, including delivery failures.
      if (user) void issue(user.id, user.email, 'PASSWORD_RESET')
        .catch(() => console.warn('Password reset email delivery failed'));
    },
    async requestVerification(userId: string) {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      if (!user.emailVerifiedAt) await issue(userId, user.email, 'EMAIL_VERIFICATION');
    },
    async consume(token: string, purpose: AccountTokenPurpose, password?: string) {
      const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
      await db.$transaction(async (tx) => {
        const record = await tx.accountToken.findUnique({ where: { tokenHash: hash(token) } });
        if (!record || record.purpose !== purpose || record.expiresAt <= new Date())
          throw new AppError(400, 'LINK_EXPIRED', 'This link is invalid or expired. Please request a new one.');
        // Atomic consumption prevents two concurrent uses of the same link.
        const consumed = await tx.accountToken.deleteMany({ where: { id: record.id } });
        if (consumed.count !== 1) throw new AppError(400, 'LINK_EXPIRED', 'This link has already been used.');
        await tx.user.update({ where: { id: record.userId }, data: purpose === 'PASSWORD_RESET'
          ? { passwordHash: passwordHash! } : { emailVerifiedAt: new Date() } });
        await tx.accountToken.deleteMany({ where: { userId: record.userId, purpose } });
        if (purpose === 'PASSWORD_RESET') await tx.refreshSession.updateMany({
          where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }, transactionOptions);
    },
    async updateProfile(userId: string, name: string) {
      return db.user.update({ where: { id: userId }, data: { name }, select: publicUserSelect });
    },
    async changePassword(userId: string, currentPassword: string, password: string) {
      const previous = await passwordMatches(userId, currentPassword);
      const passwordHash = await bcrypt.hash(password, 12);
      await db.$transaction(async (tx) => {
        const changed = await tx.user.updateMany({ where: { id: userId, passwordHash: previous.passwordHash }, data: { passwordHash } });
        if (changed.count !== 1) throw new AppError(409, 'ACCOUNT_CHANGED', 'Your account changed. Please sign in again.');
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.accountToken.deleteMany({ where: { userId, purpose: 'PASSWORD_RESET' } });
      }, transactionOptions);
    },
    async remove(userId: string, password: string) {
      const previous = await passwordMatches(userId, password);
      const result = await db.user.deleteMany({ where: { id: userId, passwordHash: previous.passwordHash } });
      if (result.count !== 1) throw new AppError(409, 'ACCOUNT_CHANGED', 'Your account changed. Please sign in again.');
    }
  };
}
