import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'Set DATABASE_URL in anitrack-backend/.env'),
  DIRECT_URL: z.string().min(1, 'Set DIRECT_URL in anitrack-backend/.env'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must contain at least 32 characters'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.enum(['0', '1']).default('0')
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
  return result.data;
}
