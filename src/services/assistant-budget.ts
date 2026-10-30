import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export interface GenerationBudget {
  reserve(inputBytes: number, outputLimit: number): Promise<(usage?: Record<string, unknown>) => Promise<void>>;
}

export function createAssistantBudget(db: PrismaClient, config: Config, now = () => new Date()): GenerationBudget {
  return {
    async reserve(inputBytes, outputLimit) {
      const day = new Date(now().toISOString().slice(0, 10));
      // Reserve before sending, including failed calls and fallback attempts.
      // Rates are operator-supplied upper bounds across the configured model pool.
      const micros = Math.ceil((inputBytes + 1024) * config.ASSISTANT_INPUT_USD_PER_MILLION
        + outputLimit * config.ASSISTANT_OUTPUT_USD_PER_MILLION);
      const ceiling = Math.floor(config.ASSISTANT_DAILY_BUDGET_USD * 1_000_000);
      if (micros > ceiling || config.ASSISTANT_DAILY_GENERATIONS === 0)
        throw new AppError(429, 'ASSISTANT_DAILY_LIMIT', 'The anime assistant has reached its daily usage limit. Please try again tomorrow.');
      await db.assistantUsageDay.upsert({ where: { day }, create: { day }, update: {} });
      const reserved = await db.assistantUsageDay.updateMany({ where: { day,
        attempts: { lt: config.ASSISTANT_DAILY_GENERATIONS }, reservedMicros: { lte: ceiling - micros } },
      data: { attempts: { increment: 1 }, reservedMicros: { increment: micros } } });
      if (reserved.count !== 1) throw new AppError(429, 'ASSISTANT_DAILY_LIMIT',
        'The anime assistant has reached its daily usage limit. Please try again tomorrow.');
      return async (usage) => {
        const count = (key: string) => typeof usage?.[key] === 'number' && Number.isSafeInteger(usage[key])
          ? Math.max(0, Math.min(usage[key] as number, 1_000_000)) : 0;
        await db.assistantUsageDay.update({ where: { day }, data: {
          inputTokens: { increment: count('total_input_tokens') },
          outputTokens: { increment: count('total_output_tokens') + count('total_thought_tokens') }
        } });
      };
    }
  };
}
