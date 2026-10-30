import type { PrismaClient } from '@prisma/client';

export async function cleanExpiredCredentials(db: PrismaClient, now = new Date()) {
  const retainedUsage = new Date(now.getTime() - 90 * 86400_000);
  // Retain revoked tokens until expiry so replay detection can still revoke their family.
  const [sessions, tokens, usage] = await Promise.all([
    db.refreshSession.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.accountToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.assistantUsageDay.deleteMany({ where: { day: { lt: retainedUsage } } })
  ]);
  return { sessions: sessions.count, tokens: tokens.count, usage: usage.count };
}

export function startMaintenance(db: PrismaClient) {
  const run = () => void cleanExpiredCredentials(db).catch(() => console.error('Credential cleanup failed'));
  run();
  const timer = setInterval(run, 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}
