import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { AppError, errorHandler } from './errors.js';
import { apiRouter } from './routes/index.js';
import { requireTrustedOrigin } from './middleware/auth.js';
import { isTrustedOrigin } from './origin.js';
import { randomUUID } from 'node:crypto';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import type { AccountMailer } from './services/mail.service.js';

export function createApp(db: PrismaClient, config: Config, dependencies: { accountMailer?: AccountMailer } = {}) {
  const app = express();
  const metrics = { requests: 0, serverErrors: 0, slowRequests: 0 };
  app.use((req, res, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      metrics.requests++;
      const durationMs = Math.round(performance.now() - started);
      if (res.statusCode >= 500) metrics.serverErrors++;
      if (durationMs >= 2000) metrics.slowRequests++;
      if (res.statusCode >= 500 || durationMs >= 2000)
        console.warn(JSON.stringify({ event: 'request', requestId, method: req.method, status: res.statusCode, durationMs }));
    });
    next();
  });
  app.disable('x-powered-by');
  if (config.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => callback(null, !!origin && isTrustedOrigin(origin, config)),
    credentials: true
  }));
  app.use(requireTrustedOrigin(config));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 200,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute.' }
      }
    })
  );
  // Limit requests before parsing bodies and reject compressed input entirely.
  app.use(express.json({ limit: '2mb', inflate: false }));
  app.use(cookieParser());
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many authentication attempts. Try again in 15 minutes.'
      }
    }
  });
  app.get('/api/health', async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });
  app.get('/api/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/admin/metrics', requireAuth(db, config), requireAdmin, (_req, res) =>
    res.json({ ...metrics, uptimeSeconds: Math.round(process.uptime()) }));
  app.use('/api', apiRouter(db, config, authLimit, dependencies.accountMailer));
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use(errorHandler);
  return app;
}
