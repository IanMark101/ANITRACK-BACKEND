import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'Set DATABASE_URL in anitrack-backend/.env'),
  DIRECT_URL: z.string().min(1, 'Set DIRECT_URL in anitrack-backend/.env'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must contain at least 32 characters'),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z
    .string()
    .regex(/^gemini-[a-zA-Z0-9.-]+$/)
    .max(100)
    .optional(),
  GEMINI_FALLBACK_MODELS: z
    .string()
    .trim()
    .max(500)
    .refine((value) => {
      const models = value.split(',').map((model) => model.trim());
      return (
        value === 'none' ||
        (models.length <= 4 && models.every((model) => /^gemini-[a-zA-Z0-9.-]{1,93}$/.test(model)))
      );
    }, 'Use up to four comma-separated Gemini model IDs, or none.')
    .optional(),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['0', '1']).default('0'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().email().optional(),
  COLLECTION_LIMIT: z.coerce.number().int().min(10).max(5000).default(500),
  ASSISTANT_DAILY_GENERATIONS: z.coerce.number().int().min(0).max(10000).default(100),
  ASSISTANT_DAILY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(5),
  ASSISTANT_INPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).default(6),
  ASSISTANT_OUTPUT_USD_PER_MILLION: z.coerce.number().positive().max(1000).default(30)
});

export type Config = z.infer<typeof schema>;
export function loadConfig(): Config {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    );
  if (result.data.NODE_ENV === 'production' && !result.data.CLIENT_ORIGIN.startsWith('https://')) {
    throw new Error('Production CLIENT_ORIGIN must use HTTPS.');
  }
  if ((result.data.SMTP_USER && !result.data.SMTP_PASSWORD) || (!result.data.SMTP_USER && result.data.SMTP_PASSWORD))
    throw new Error('Set both SMTP_USER and SMTP_PASSWORD.');
  if (result.data.SMTP_HOST && !result.data.MAIL_FROM)
    throw new Error('Set MAIL_FROM when SMTP_HOST is configured.');
  return result.data;
}
