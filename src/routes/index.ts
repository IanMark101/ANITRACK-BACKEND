import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import { createAuthService } from '../services/auth.service.js';
import { createWatchlistService } from '../services/watchlist.service.js';
import { createCatalogService } from '../services/catalog.service.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createWatchlistController } from '../controllers/watchlist.controller.js';
import { createCatalogController } from '../controllers/catalog.controller.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

export function apiRouter(db: PrismaClient, config: Config, authLimit: RequestHandler) {
  const router = Router();
  const protect = requireAuth(db, config);
  const auth = createAuthController(createAuthService(db, config), db, config);
  const watchlist = createWatchlistController(createWatchlistService(db));
  const catalog = createCatalogController(createCatalogService(db));
  router.post('/auth/register', authLimit, auth.register);
  router.post('/auth/login', authLimit, auth.login);
  router.post('/auth/logout', auth.logout);
  router.post('/auth/refresh', authLimit, auth.refresh);
  router.get('/auth/me', protect, auth.me);
  router.get('/anime/meta', catalog.meta);
  router.get('/anime', catalog.list);
  router.get('/anime/:id', catalog.get);
  router.post('/anime', protect, requireAdmin, catalog.create);
  router.patch('/anime/:id', protect, requireAdmin, catalog.update);
  router.delete('/anime/:id', protect, requireAdmin, catalog.remove);
  router.get('/watchlist', protect, watchlist.list);
  router.post('/watchlist', protect, watchlist.create);
  router.post('/watchlist/reset', protect, watchlist.reset);
  router.put('/watchlist/spotlight', protect, watchlist.spotlight);
  router.get('/watchlist/:id', protect, watchlist.get);
  router.patch('/watchlist/:id', protect, watchlist.update);
  router.delete('/watchlist/:id', protect, watchlist.remove);
  return router;
}
