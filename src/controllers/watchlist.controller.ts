import type { RequestHandler } from 'express';
import type { AuthRequest } from '../middleware/auth.js';
import type { createWatchlistService } from '../services/watchlist.service.js';
import {
  createEntrySchema,
  updateEntrySchema,
  spotlightSchema,
  importAnimeSchema,
  progressSchema,
  calendarQuerySchema,
  listQuerySchema
} from '../validation.js';

export function createWatchlistController(service: ReturnType<typeof createWatchlistService>) {
  const userId = (req: Parameters<RequestHandler>[0]) => (req as AuthRequest).user.id;
  const id = (req: Parameters<RequestHandler>[0]) => String(req.params.id);
  return {
    importAnime: (async (req, res) => {
      const result = await service.importAnime(
        userId(req),
        importAnimeSchema.parse(req.body).externalId
      );
      res.status(result.created ? 201 : 200).json(result);
    }) as RequestHandler,
    progress: (async (req, res) =>
      res.json({
        item: await service.progress(userId(req), id(req), progressSchema.parse(req.body).delta)
      })) as RequestHandler,
    calendar: (async (req, res) =>
      res.json(
        await service.calendar(userId(req), calendarQuerySchema.parse(req.query).week)
      )) as RequestHandler,
    list: (async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      res.json(await service.list(userId(req), query.page, Math.min(query.limit, 20)));
    }) as RequestHandler,
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
