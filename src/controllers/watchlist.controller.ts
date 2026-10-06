import type { RequestHandler } from 'express';
import type { AuthRequest } from '../middleware/auth.js';
import type { createWatchlistService } from '../services/watchlist.service.js';
import { createEntrySchema, updateEntrySchema, spotlightSchema } from '../validation.js';

export function createWatchlistController(service: ReturnType<typeof createWatchlistService>) {
  const userId = (req: Parameters<RequestHandler>[0]) => (req as AuthRequest).user.id;
  const id = (req: Parameters<RequestHandler>[0]) => String(req.params.id);
  return {
    list: (async (req, res) => res.json(await service.list(userId(req)))) as RequestHandler,
    get: (async (req, res) =>
      res.json({ item: await service.get(userId(req), id(req)) })) as RequestHandler,
    create: (async (req, res) =>
      res.status(201).json({
        item: await service.create(userId(req), createEntrySchema.parse(req.body))
      })) as RequestHandler,
    update: (async (req, res) =>
      res.json({
        item: await service.update(userId(req), id(req), updateEntrySchema.parse(req.body))
      })) as RequestHandler,
    remove: (async (req, res) => {
      await service.remove(userId(req), id(req));
      res.status(204).end();
    }) as RequestHandler,
    spotlight: (async (req, res) =>
      res.json(
        await service.spotlight(userId(req), spotlightSchema.parse(req.body).entryId)
      )) as RequestHandler,
    reset: (async (req, res) => res.json(await service.reset(userId(req)))) as RequestHandler
  };
}
