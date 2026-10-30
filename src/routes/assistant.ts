import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { AnimeProvider } from '../services/anime-provider.js';
import {
  assistantInput,
  createAnimeAssistant,
  createGeminiInterpreter,
  type AssistantInterpreter
} from '../services/anime-assistant.js';
import type { GenerationBudget } from '../services/assistant-budget.js';

export function assistantRouter(
  config: Config,
  provider: Pick<AnimeProvider, 'search'>,
  interpreter?: AssistantInterpreter,
  budget?: GenerationBudget
) {
  const router = Router();
  const assistant = createAnimeAssistant(provider, interpreter ?? createGeminiInterpreter(config, fetch, budget));
  router.post(
    '/',
    rateLimit({
      windowMs: 5 * 60_000,
      limit: 12,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: {
          code: 'ASSISTANT_RATE_LIMITED',
          message: 'You have made several requests. Please wait a few minutes before trying again.'
        }
      }
    }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const controller = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', cancel);
      try {
        res.json(await assistant.run(assistantInput.parse(req.body), controller.signal));
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        res.off('close', cancel);
      }
    }
  );
  return router;
}
