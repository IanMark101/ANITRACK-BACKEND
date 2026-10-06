import type { RequestHandler } from 'express';
import type { createCatalogService } from '../services/catalog.service.js';
import { animeSchema, updateAnimeSchema } from '../validation.js';

export function createCatalogController(service: ReturnType<typeof createCatalogService>) {
  const id = (req: Parameters<RequestHandler>[0]) => String(req.params.id);
  return {
    list: (async (_req, res) => res.json(await service.list())) as RequestHandler,
    meta: (async (_req, res) => res.json(await service.meta())) as RequestHandler,
    get: (async (req, res) => res.json({ item: await service.get(id(req)) })) as RequestHandler,
    create: (async (req, res) =>
      res
        .status(201)
        .json({ item: await service.create(animeSchema.parse(req.body)) })) as RequestHandler,
    update: (async (req, res) =>
      res.json({
        item: await service.update(id(req), updateAnimeSchema.parse(req.body))
      })) as RequestHandler,
    remove: (async (req, res) => {
      await service.remove(id(req));
      res.status(204).end();
    }) as RequestHandler
  };
}
