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
      data: { inputTokens: { increment: 100 }, outputTokens: { increment: 50 } } });
  });
});
