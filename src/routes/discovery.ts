import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { AnimeProvider } from '../services/anime-provider.js';
import { discoveryQuerySchema, externalIdSchema, pageQuerySchema } from '../validation.js';
import { AppError } from '../errors.js';

export function discoveryRouter(db: PrismaClient, provider: AnimeProvider) {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json(await provider.search(discoveryQuerySchema.parse(req.query)))
  );
  router.get('/:id/episodes', async (req, res) =>
    res.json(
      await provider.episodes(
        externalIdSchema.parse(req.params.id),
        pageQuerySchema.parse(req.query).page
      )
    )
  );
  router.get('/:id/related', async (req, res) =>
    res.json(await provider.relations(externalIdSchema.parse(req.params.id)))
  );
  router.get('/:id/similar', async (req, res) =>
    res.json(await provider.similar(externalIdSchema.parse(req.params.id)))
  );
  router.get('/:id', async (req, res) => {
    const id = externalIdSchema.parse(req.params.id);
    try {
      res.json({ item: await provider.get(id), stale: false });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) throw error;
      const saved = await db.anime.findUnique({
        where: { provider_externalId: { provider: 'KITSU', externalId: id } },
        select: { details: true }
      });
      if (!saved?.details) throw error;
      res.json({
        item: saved.details,
        stale: true,
        notice: 'Showing saved details while live discovery is unavailable.'
      });
    }
  });
  return router;
}
