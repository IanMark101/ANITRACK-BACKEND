import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AppError, errorHandler } from '../src/errors.js';
import { assistantRouter } from '../src/routes/assistant.js';
import { normalizeAnime } from '../src/services/anime-provider.js';
import {
  assistantInput,
  createAnimeAssistant,
  createGeminiInterpreter,
  type AssistantPlan
} from '../src/services/anime-assistant.js';
import { testConfig } from './helpers.js';

const input = assistantInput.parse({ mode: 'recommend', message: 'Adventure' });
const plan: AssistantPlan = {
  relevant: false,
  summary: 'Another clue is needed.',
  question: 'What setting do you remember?',
  titles: [],
  genres: [],
  excludeGenres: [],
  maxEpisodes: null,
  completedOnly: false,
  format: 'any'
};
const modelResponse = (value: unknown) =>
  new Response(
    JSON.stringify({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }]
    })
  );

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('Assistant model and quota audit', () => {
  it.each([undefined, 'gemini-audit-override'])(
    'uses the same selected model for both stages (override: %s)',
    async (model) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(modelResponse(plan))
        .mockResolvedValueOnce(modelResponse({ matches: [], question: '' }));
      const interpreter = createGeminiInterpreter(
        { GEMINI_API_KEY: 'audit-test-key', GEMINI_MODEL: model },
        fetcher
      );
      await interpreter.plan(input, new AbortController().signal);
      await interpreter.rank(input, plan, [], new AbortController().signal);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies.map((body) => body.model)).toEqual(
        Array(2).fill(model || 'gemini-3.5-flash-lite')
      );
      expect(bodies.every((body) => body.generation_config.max_output_tokens === 3000)).toBe(true);
    }
  );

  it.each([429, 503, 500, 401, 402, 403])(
    'stops after provider HTTP %s when backups are disabled, without leaking diagnostics',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'private-provider-diagnostic', status: 'RESOURCE_EXHAUSTED' }
          }),
          { status, headers: { 'Retry-After': '15' } }
        )
      );
      const interpreter = createGeminiInterpreter(
        { GEMINI_API_KEY: 'audit-test-key', GEMINI_FALLBACK_MODELS: 'none' },
        fetcher
      );
      const failure = await interpreter
        .plan(input, new AbortController().signal)
        .catch((error) => error);
      expect(failure).toMatchObject({
        status: 503,
        code: status === 429 ? 'ASSISTANT_BUSY' : 'ASSISTANT_UNAVAILABLE'
      });
      expect(failure.message).not.toContain('private-provider-diagnostic');
      expect(failure.message).not.toContain('audit-test-key');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a truncated JSON answer without a second generation attempt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: '{"relevant":true,"titles":[' }]
            }
          ]
        })
      )
    );
    await expect(
      createGeminiInterpreter(
        { GEMINI_API_KEY: 'audit-test-key', GEMINI_FALLBACK_MODELS: 'none' },
        fetcher
      ).plan(input, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete token-limited interaction even when its partial JSON is valid', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'incomplete',
          continuation_token: 'audit-continuation-token',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(plan) }] }]
        })
      )
    );
    await expect(
      createGeminiInterpreter(
        { GEMINI_API_KEY: 'audit-test-key', GEMINI_FALLBACK_MODELS: 'none' },
        fetcher
      ).plan(input, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts the provider request at its deadline without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error('An expired request must not reach generation.');
    });
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException('Audit deadline', 'TimeoutError'))
      );
    await expect(
      createGeminiInterpreter(
        { GEMINI_API_KEY: 'audit-test-key', GEMINI_FALLBACK_MODELS: 'none' },
        fetcher
      ).plan(input, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a fourth concurrent search and releases capacity after failures', async () => {
    let fail!: (error: Error) => void;
    const pending = new Promise<AssistantPlan>((_resolve, reject) => {
      fail = reject;
    });
    const interpreter = { plan: vi.fn().mockReturnValue(pending), rank: vi.fn() };
    const service = createAnimeAssistant({ search: vi.fn() }, interpreter);
    const active = [service.run(input), service.run(input), service.run(input)];
    const outcomes = Promise.allSettled(active);
    await expect(service.run(input)).rejects.toMatchObject({ code: 'ASSISTANT_BUSY' });
    expect(interpreter.plan).toHaveBeenCalledTimes(3);
    fail(new AppError(503, 'ASSISTANT_UNAVAILABLE', 'Simulated provider failure'));
    expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
    interpreter.plan.mockResolvedValue(plan);
    await expect(service.run(input)).resolves.toMatchObject({ items: [] });
    expect(interpreter.plan).toHaveBeenCalledTimes(4);
  });

  it('returns a safe HTTP error when quota is exhausted during ranking', async () => {
    const interpreter = {
      plan: vi.fn().mockResolvedValue({ ...plan, relevant: true }),
      rank: vi
        .fn()
        .mockRejectedValue(new AppError(503, 'ASSISTANT_BUSY', 'The anime assistant is busy.'))
    };
    const candidate = normalizeAnime({
      id: '1',
      type: 'anime',
      attributes: { canonicalTitle: 'Audit adventure' }
    });
    const provider = { search: vi.fn().mockResolvedValue({ items: [candidate] }) };
    const app = express()
      .use(express.json())
      .use('/assistant', assistantRouter(testConfig, provider, interpreter))
      .use(errorHandler);
    const result = await request(app).post('/assistant').send(input);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: { code: 'ASSISTANT_BUSY', message: 'The anime assistant is busy.' }
    });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).not.toHaveProperty('items');
    expect(interpreter.rank).toHaveBeenCalledTimes(1);
  });
});
