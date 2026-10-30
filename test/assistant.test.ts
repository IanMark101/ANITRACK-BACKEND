import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/errors.js';
import { normalizeAnime } from '../src/services/anime-provider.js';
import {
  assistantInput,
  createAnimeAssistant,
  createGeminiInterpreter,
  type AssistantPlan,
  type AssistantInterpreter
} from '../src/services/anime-assistant.js';
import { assistantRouter } from '../src/routes/assistant.js';
import { testConfig } from './helpers.js';

const onePiece = {
  ...normalizeAnime({
    id: '1',
    type: 'anime',
    attributes: {
      canonicalTitle: 'One Piece',
      synopsis: 'A rubber-bodied pirate searches for treasure.',
      episodeCount: 1000,
      status: 'current',
      subtype: 'TV'
    }
  }),
  genres: ['Adventure', 'Comedy']
};
const shortStory = {
  ...onePiece,
  externalId: '2',
  title: 'An Adventure',
  totalEpisodes: 12,
  airingStatus: 'finished',
  genres: ['Adventure']
};
const plan: AssistantPlan = {
  relevant: true,
  summary: 'Looking for adventure.',
  question: '',
  titles: [],
  genres: ['Adventure'],
  excludeGenres: [],
  maxEpisodes: null,
  completedOnly: false,
  format: 'any'
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const modelResponse = (data: unknown) =>
  response({
    status: 'completed',
    steps: [
      { type: 'thought', signature: 'private-thought' },
      {
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify(data) }]
      }
    ]
  });
function setup(overrides: Partial<AssistantPlan> = {}) {
  const interpreter = {
    plan: vi.fn().mockResolvedValue({ ...plan, ...overrides }),
    rank: vi.fn().mockResolvedValue({
      matches: [
        {
          id: '2',
          reason: 'An adventure to consider.',
          evidence: 'pirate searches for treasure'
        }
      ],
      question: ''
    })
  };
  const provider = {
    search: vi.fn().mockResolvedValue({
      items: [onePiece, shortStory],
      page: 1,
      hasNext: false,
      total: 2,
      source: 'Kitsu'
    })
  };
  return {
    interpreter,
    provider,
    service: createAnimeAssistant(provider, interpreter)
  };
}

describe('Anime assistant matching', () => {
  it('enforces genres, exclusions, episode limits, finished status, and saved-title exclusions before ranking', async () => {
    const { service, interpreter, provider } = setup({
      maxEpisodes: 24,
      completedOnly: true,
      excludeGenres: ['Comedy']
    });
    const result = await service.run(
      assistantInput.parse({
        mode: 'recommend',
        message: 'A short completed adventure, without comedy.'
      })
    );
    expect(result.items.map((item) => item.anime.externalId)).toEqual(['2']);
    expect(result.items[0].facts).toEqual(['Adventure', 'Finished airing', '12 episodes']);
    expect(
      interpreter.rank.mock.calls[0][2].map((item: typeof onePiece) => item.externalId)
    ).toEqual(['2']);
    expect(provider.search).toHaveBeenCalledWith({
      genre: 'Adventure',
      view: 'top'
    });
    interpreter.rank.mockClear();
    const excluded = await service.run(
      assistantInput.parse({
        mode: 'recommend',
        message: 'Adventure',
        excludeIds: ['2']
      })
    );
    expect(excluded.items).toEqual([]);
    expect(interpreter.rank).not.toHaveBeenCalled();
  });
  it('returns one exact title match without an unnecessary second model request', async () => {
    const { service, interpreter } = setup({
      titles: ['ONE PIECE'],
      genres: []
    });
    const result = await service.run(
      assistantInput.parse({
        mode: 'identify',
        message: 'A stretchy pirate with a straw hat.'
      })
    );
    expect(result.items.map((item) => item.anime.externalId)).toEqual(['1']);
    expect(interpreter.rank).not.toHaveBeenCalled();
  });
  it('discards invented and duplicate ranked result IDs', async () => {
    const { service, interpreter } = setup({ genres: [] });
    interpreter.rank.mockResolvedValue({
      matches: [
        { id: 'invented', reason: 'Invented result', evidence: 'pirate' },
        {
          id: '1',
          reason: 'The pirate detail may match.',
          evidence: 'pirate searches for treasure'
        },
        { id: '1', reason: 'Duplicate', evidence: '' }
      ],
      question: ''
    });
    const result = await service.run(
      assistantInput.parse({
        mode: 'recommend',
        message: 'An adventure with pirates.'
      })
    );
    expect(result.items.map((item) => item.anime.externalId)).toEqual(['1']);
    expect(result.items[0].reason).toBe('The pirate detail may match.');
  });
  it('asks for another clue when identification is too vague without searching or inventing a title', async () => {
    const { service, provider, interpreter } = setup({
      titles: [],
      question: 'Can you remember a character or scene?'
    });
    const result = await service.run(
      assistantInput.parse({
        mode: 'identify',
        message: 'A boy goes on a journey.'
      })
    );
    expect(result.items).toEqual([]);
    expect(result.question).toContain('character');
    expect(provider.search).not.toHaveBeenCalled();
    expect(interpreter.rank).not.toHaveBeenCalled();
  });
  it('does not display invented synopsis evidence or an unsupported explanation', async () => {
    const { service, interpreter } = setup();
    interpreter.rank.mockResolvedValue({
      matches: [
        {
          id: '2',
          reason: 'A claim not in the catalog',
          evidence: 'an invented quotation'
        }
      ],
      question: ''
    });
    const result = await service.run(
      assistantInput.parse({ mode: 'recommend', message: 'Adventure' })
    );
    expect(result.items[0].evidence).toBe('');
    expect(result.items[0].reason).not.toContain('claim');
  });
  it('reports provider downtime and does not turn it into a misleading no-match response', async () => {
    const { service, provider } = setup();
    provider.search.mockRejectedValue(new Error('Provider offline'));
    await expect(
      service.run(assistantInput.parse({ mode: 'recommend', message: 'Adventure' }))
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('keeps refinements and filters unknown episode totals when a maximum is requested', async () => {
    const { service, provider, interpreter } = setup({ maxEpisodes: 24 });
    provider.search.mockResolvedValue({
      items: [{ ...shortStory, totalEpisodes: null }],
      page: 1,
      hasNext: false,
      total: 1,
      source: 'Kitsu'
    });
    const input = assistantInput.parse({
      mode: 'recommend',
      message: 'Under 24 episodes.',
      context: ['Adventure without romance.']
    });
    expect((await service.run(input)).items).toEqual([]);
    expect(interpreter.plan.mock.calls[0][0].context).toEqual(['Adventure without romance.']);
  });
});

describe('Gemini integration', () => {
  it('keeps the API key in a server header, uses structured output, and disables interaction storage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(modelResponse(plan));
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-private-key' }, fetcher);
    expect(
      await interpreter.plan(
        assistantInput.parse({
          mode: 'recommend',
          message: 'Adventure',
          excludeIds: ['123456']
        }),
        AbortSignal.timeout(1000)
      )
    ).toEqual(plan);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain('test-private-key');
    expect(init?.headers).toMatchObject({
      'x-goog-api-key': 'test-private-key'
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      store: false,
      response_format: { mime_type: 'application/json' }
    });
    expect(String(init?.body)).not.toContain('123456');
  });
  it('rejects malformed model output instead of returning unvalidated content', async () => {
    const interpreter = createGeminiInterpreter(
      { GEMINI_API_KEY: 'test-private-key' },
      vi.fn<typeof fetch>().mockResolvedValue(modelResponse({ titles: ['Imaginary'] }))
    );
    await expect(
      interpreter.plan(
        assistantInput.parse({ mode: 'identify', message: 'A story' }),
        AbortSignal.timeout(1000)
      )
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
  });
  it('handles missing credentials without making a request and quota limits without leaking provider responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: { message: 'secret diagnostic' } }, 429));
    const input = assistantInput.parse({
      mode: 'recommend',
      message: 'Adventure'
    });
    await expect(
      createGeminiInterpreter({}, fetcher).plan(input, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      createGeminiInterpreter({ GEMINI_API_KEY: 'key' }, fetcher).plan(
        input,
        AbortSignal.timeout(1000)
      )
    ).rejects.toMatchObject({ code: 'ASSISTANT_BUSY' });
  });
});

describe('Assistant HTTP route', () => {
  function app() {
    const { provider, interpreter } = setup({
      genres: [],
      titles: [],
      question: 'Another clue?'
    });
    return express()
      .use(express.json())
      .use(
        '/api/assistant',
        assistantRouter(testConfig, provider, interpreter as AssistantInterpreter)
      )
      .use(errorHandler);
  }
  it('validates mode, request length, context, and excluded IDs before any model call', async () => {
    for (const body of [
      { mode: 'other', message: 'Adventure' },
      { mode: 'recommend', message: 'Adventure', model: 'gemini-unapproved' },
      { mode: 'recommend', message: 'a'.repeat(1201) },
      { mode: 'identify', message: 'story', context: Array(4).fill('story') },
      { mode: 'recommend', message: 'Adventure', excludeIds: ['../123'] }
    ]) {
      expect((await request(app()).post('/api/assistant').send(body)).status).toBe(400);
    }
  });
  it('works for guests, disables response caching, and rate-limits repeated submissions', async () => {
    const server = app();
    const input = { mode: 'identify', message: 'A vague story.' };
    const first = await request(server).post('/api/assistant').send(input);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    for (let attempt = 0; attempt < 11; attempt++)
      await request(server).post('/api/assistant').send(input);
    const blocked = await request(server).post('/api/assistant').send(input);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('ASSISTANT_RATE_LIMITED');
  });
});
