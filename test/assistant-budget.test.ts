import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAssistantBudget } from '../src/services/assistant-budget.js';
import { createGeminiInterpreter } from '../src/services/anime-assistant.js';
import { AppError } from '../src/errors.js';
import { testConfig } from './helpers.js';

describe('Persistent assistant budget', () => {
  it('rejects a generation before contacting the provider when budget is exhausted', async () => {
    const fetcher = vi.fn();
    const reserve = vi.fn().mockRejectedValue(new AppError(429, 'ASSISTANT_DAILY_LIMIT', 'Daily limit'));
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'unused-test-key' }, fetcher, { reserve });
    await expect(interpreter.plan({ mode: 'identify', message: 'anime clue', context: [], excludeIds: [] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ASSISTANT_DAILY_LIMIT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('records only bounded numeric token counts without saving message content', async () => {
    const update = vi.fn().mockResolvedValue({});
    const db = { assistantUsageDay: { upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), update } } as unknown as PrismaClient;
    const budget = createAssistantBudget(db, testConfig, () => new Date('2026-10-30T12:00:00Z'));
    const record = await budget.reserve(1000, 6000);
    await record({ total_input_tokens: 100, total_output_tokens: 30, total_thought_tokens: 20 });
    expect(update).toHaveBeenCalledWith({ where: { day: new Date('2026-10-30') },
      data: { inputTokens: { increment: 100 }, outputTokens: { increment: 50 },
        reservedMicros: { increment: -190044 } } });
  });
  it.each([undefined, {}, { total_input_tokens: 10, total_output_tokens: 5 },
    { total_input_tokens: -1, total_output_tokens: 5, total_thought_tokens: 0 },
    { total_input_tokens: 10, total_output_tokens: '5', total_thought_tokens: 0 }])(
    'retains a conservative reservation with incomplete or invalid usage %j', async usage => {
      const update = vi.fn().mockResolvedValue({});
      const db = { assistantUsageDay: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update } } as unknown as PrismaClient;
      const record = await createAssistantBudget(db, testConfig).reserve(1000, 6000);
      await record(usage);
      expect(update.mock.calls[0][0].data.reservedMicros).toEqual({ increment: 0 });
    }
  );
  it('settles once, against the original UTC day even if the response crosses midnight', async () => {
    let now = new Date('2026-11-18T23:59:59Z');
    const update = vi.fn().mockResolvedValue({});
    const db = { assistantUsageDay: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update } } as unknown as PrismaClient;
    const record = await createAssistantBudget(db, testConfig, () => now).reserve(1000, 6000);
    now = new Date('2026-11-19T00:00:01Z');
    const usage = { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 0 };
    await Promise.all([record(usage), record(usage)]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where.day).toEqual(new Date('2026-11-18'));
  });
  it('does not repeat a successful generation if usage accounting has a database failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = { assistantUsageDay: { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockRejectedValue(new Error('temporary accounting failure')) } } as unknown as PrismaClient;
      const reserve = createAssistantBudget(db, testConfig).reserve;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        status: 'completed', usage: { total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 0 },
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ relevant: false,
          summary: '', question: 'Which anime?', titles: [], genres: [], excludeGenres: [], maxEpisodes: null,
          completedOnly: false, format: 'any' }) }] }]
      })));
      await expect(createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher, { reserve }).plan(
        { mode: 'identify', message: 'anime clue', context: [], excludeIds: [] }, new AbortController().signal
      )).resolves.toMatchObject({ relevant: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); }
  });
  it('allows repeated small successful calls without exhausting the budget through unused reservations', async () => {
    const ledger = { reservedMicros: 0, attempts: 0 };
    const db = { assistantUsageDay: {
      upsert: vi.fn(),
      updateMany: vi.fn(async ({ where, data }) => {
        if (ledger.attempts >= where.attempts.lt || ledger.reservedMicros > where.reservedMicros.lte)
          return { count: 0 };
        ledger.attempts += data.attempts.increment;
        ledger.reservedMicros += data.reservedMicros.increment;
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => { ledger.reservedMicros += data.reservedMicros.increment; })
    } } as unknown as PrismaClient;
    const budget = createAssistantBudget(db, testConfig);
    for (let i = 0; i < 30; i++) {
      const record = await budget.reserve(1000, 6000);
      await record({ total_input_tokens: 100, total_output_tokens: 50, total_thought_tokens: 0 });
    }
    expect(ledger).toEqual({ attempts: 30, reservedMicros: 63000 });
  });
});
