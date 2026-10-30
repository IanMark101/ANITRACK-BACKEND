import { Router, type Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../config.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { createCollectionsService } from '../services/collections.service.js';

const id = z.string().min(1).max(100);
const fields = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default('') }).strict();
// Reject oversized arrays before validating their elements or allocating issues.
const entryIds = z.unknown().superRefine((value, ctx) => {
  if (!Array.isArray(value) || value.length > 100) ctx.addIssue({ code: 'custom', message: 'Choose at most 100 saved titles.' });
}).pipe(z.array(id).max(100));
const entries = z.object({ entryIds }).strict();
export function collectionsRouter(db: PrismaClient, config: Config) {
  const router = Router();
  router.use(requireAuth(db, config));
  const service = createCollectionsService(db);
  const params = (req: Request) => ({ userId: (req as AuthRequest).user.id });
  router.get('/', async (req, res) => res.json(await service.list(params(req).userId,
    z.coerce.number().int().min(1).max(100).default(1).parse(req.query.page),
    z.string().trim().max(100).default('').parse(req.query.q))));
  router.post('/', async (req, res) => res.status(201).json({ item: await service.create(params(req).userId, fields.parse(req.body)) }));
  router.get('/:id', async (req, res) => res.json({ item: await service.get(params(req).userId, id.parse(req.params.id)) }));
  router.patch('/:id', async (req, res) => res.json({ item: await service.update(params(req).userId, id.parse(req.params.id), fields.parse(req.body)) }));
  router.delete('/:id', async (req, res) => { await service.remove(params(req).userId, id.parse(req.params.id)); res.status(204).end(); });
  router.post('/:id/items', async (req, res) => { await service.add(params(req).userId, id.parse(req.params.id), entries.parse(req.body).entryIds); res.status(204).end(); });
  router.delete('/:id/items/:entryId', async (req, res) => { await service.removeItem(params(req).userId, id.parse(req.params.id), id.parse(req.params.entryId)); res.status(204).end(); });
  router.put('/:id/order', async (req, res) => { await service.reorder(params(req).userId, id.parse(req.params.id), entries.parse(req.body).entryIds); res.status(204).end(); });
  return router;
}
