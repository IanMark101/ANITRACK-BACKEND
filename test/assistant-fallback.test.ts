import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { errorHandler } from '../src/errors.js';
import { assistantRouter } from '../src/routes/assistant.js';
import {
  assistantInput,
  createAnimeAssistant,
  createGeminiInterpreter,
  type AssistantPlan
} from '../src/services/anime-assistant.js';
import { normalizeAnime } from '../src/services/anime-provider.js';
import { testConfig } from './helpers.js';

const primary = 'gemini-3.5-flash-lite';
const backup = 'gemini-3.1-flash-lite';
const last = 'gemini-3.6-flash';
const input = assistantInput.parse({ mode: 'recommend', message: 'Adventure' });
const plan: AssistantPlan = {
  relevant: true,
  summary: 'Adventure.',
  question: '',
  titles: [],
  genres: [],
  excludeGenres: [],
  maxEpisodes: null,
  completedOnly: false,
  format: 'any'
};
const modelResponse = (value: unknown, status = 'completed') =>
  new Response(
    JSON.stringify({
      status,
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }]
    })
  );
const requested = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model);

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('Gemini model fallback', () => {
  it.each([404, 408, 429, 500, 502, 503, 504])(
    'switches models after HTTP %s and skips the failed primary during ranking',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{}', { status }))
        .mockResolvedValueOnce(modelResponse(plan))
        .mockResolvedValueOnce(modelResponse({ matches: [], question: '' }));
      const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher);
      await expect(interpreter.plan(input, new AbortController().signal)).resolves.toEqual(plan);
      await interpreter.rank(input, plan, [], new AbortController().signal);
      expect(requested(fetcher)).toEqual([primary, backup, backup]);
    }
  );

  it.each([400, 401, 402, 403])(
    'does not rotate for account or request error HTTP %s',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status }));
      await expect(
        createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
          input,
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
      expect(requested(fetcher)).toEqual([primary]);
    }
  );

  it('uses the third model when both earlier models are unavailable', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(modelResponse(plan));
    await expect(
      createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
        input,
        new AbortController().signal
      )
    ).resolves.toEqual(plan);
    expect(requested(fetcher)).toEqual([primary, backup, last]);
  });

  it('limits each stage to three attempts even with a larger configured list', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 503 }));
    const interpreter = createGeminiInterpreter(
      {
        GEMINI_API_KEY: 'test-key',
        GEMINI_FALLBACK_MODELS: `${backup},${last},gemini-extra-one,gemini-extra-two`
      },
      fetcher
    );
    await expect(interpreter.plan(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'ASSISTANT_UNAVAILABLE'
    });
    expect(requested(fetcher)).toEqual([primary, backup, last]);
    fetcher.mockResolvedValueOnce(modelResponse(plan));
    await expect(interpreter.plan(input, new AbortController().signal)).resolves.toEqual(plan);
    expect(requested(fetcher).at(-1)).toBe('gemini-extra-one');
  });

  it('fails immediately without more provider calls when all models are cooling down', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 429 }));
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher);
    await expect(interpreter.plan(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'ASSISTANT_BUSY'
    });
    await expect(interpreter.plan(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'ASSISTANT_BUSY'
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['120', 'Thu, 29 Oct 2026 04:02:00 GMT'])(
    'respects Retry-After %s and retries the primary after cooldown expires',
    async (retryAfter) => {
      let now = Date.parse('2026-10-29T04:00:00Z');
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('{}', { status: 429, headers: { 'Retry-After': retryAfter } })
        )
        .mockImplementation(async () => modelResponse(plan));
      const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher);
      await interpreter.plan(input, new AbortController().signal);
      now += 61000;
      await interpreter.plan(input, new AbortController().signal);
      expect(requested(fetcher)).toEqual([primary, backup, backup]);
      now += 60000;
      await interpreter.plan(input, new AbortController().signal);
      expect(requested(fetcher).at(-1)).toBe(primary);
    }
  );

  it('uses a five-minute cooldown for an unavailable model ID', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockImplementation(async () => modelResponse(plan));
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher);
    await interpreter.plan(input, new AbortController().signal);
    now += 60001;
    await interpreter.plan(input, new AbortController().signal);
    expect(requested(fetcher)).toEqual([primary, backup, backup]);
    now += 240000;
    await interpreter.plan(input, new AbortController().signal);
    expect(requested(fetcher).at(-1)).toBe(primary);
  });

  it.each(['network', 'timeout', 'malformed', 'schema', 'incomplete'])(
    'falls back after %s failure and validates the backup answer',
    async (failure) => {
      const fetcher = vi.fn<typeof fetch>();
      if (failure === 'network' || failure === 'timeout')
        fetcher.mockRejectedValueOnce(
          new DOMException(
            'Simulated failure',
            failure === 'timeout' ? 'TimeoutError' : 'NetworkError'
          )
        );
      else if (failure === 'malformed') fetcher.mockResolvedValueOnce(new Response('invalid JSON'));
      else
        fetcher.mockResolvedValueOnce(
          modelResponse(
            failure === 'schema' ? {} : plan,
            failure === 'incomplete' ? 'incomplete' : 'completed'
          )
        );
      fetcher.mockResolvedValueOnce(modelResponse(plan));
      await expect(
        createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
          input,
          new AbortController().signal
        )
      ).resolves.toEqual(plan);
      expect(requested(fetcher)).toEqual([primary, backup]);
    }
  );

  it('does not rotate a failed or blocked interaction', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(modelResponse({}, 'failed'));
    await expect(
      createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
        input,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('deduplicates model IDs without changing their configured order', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 503 }));
    await expect(
      createGeminiInterpreter(
        {
          GEMINI_API_KEY: 'test-key',
          GEMINI_FALLBACK_MODELS: `${primary}, ${backup},${backup},${last}`
        },
        fetcher
      ).plan(input, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(requested(fetcher)).toEqual([primary, backup, last]);
  });

  it('does not start a provider request after the search was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
        input,
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not start a backup after cancellation aborts a running model request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return modelResponse(plan);
    });
    await expect(
      createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher).plan(
        input,
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not start ranking after cancellation during the catalog search', async () => {
    const controller = new AbortController();
    const interpreter = { plan: vi.fn().mockResolvedValue(plan), rank: vi.fn() };
    const provider = {
      search: vi.fn().mockImplementation(async () => {
        controller.abort();
        return {
          items: [
            normalizeAnime({ id: '1', type: 'anime', attributes: { canonicalTitle: 'Adventure' } })
          ]
        };
      })
    };
    await expect(
      createAnimeAssistant(provider, interpreter).run(input, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(interpreter.rank).not.toHaveBeenCalled();
  });
});

describe('Assistant HTTP disconnect', () => {
  it('aborts the in-flight interpreter when the client disconnects', async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const interpreter = {
      plan: vi.fn(
        (_input, signal: AbortSignal) =>
          new Promise<AssistantPlan>((_resolve, reject) => {
            started();
            signal.addEventListener(
              'abort',
              () => {
                cancelled();
                reject(signal.reason);
              },
              { once: true }
            );
          })
      ),
      rank: vi.fn()
    };
    const app = express()
      .use(express.json())
      .use('/assistant', assistantRouter(testConfig, { search: vi.fn() }, interpreter))
      .use(errorHandler);
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server missing address');
    const client = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/assistant',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    client.on('error', () => {});
    try {
      client.end(JSON.stringify(input));
      await start;
      client.destroy();
      await cancel;
      expect(interpreter.rank).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
