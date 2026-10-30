import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

beforeEach(() => {
  for (const [name, value] of Object.entries(testConfig)) vi.stubEnv(name, String(value));
  vi.stubEnv('GEMINI_MODEL', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Assistant model configuration', () => {
  it.each(['none', 'gemini-3.1-flash-lite, gemini-3.6-flash'])('accepts %s', (models) => {
    vi.stubEnv('GEMINI_FALLBACK_MODELS', models);
    expect(loadConfig().GEMINI_FALLBACK_MODELS).toBe(models);
  });
  it('keeps an empty setting optional so the default backup list applies', () => {
    vi.stubEnv('GEMINI_FALLBACK_MODELS', '');
    expect(loadConfig().GEMINI_FALLBACK_MODELS).toBeUndefined();
  });
  it.each([
    'https://untrusted.example/model',
    'gemini-one,,gemini-two',
    'gemini-one,gemini-two,gemini-three,gemini-four,gemini-five',
    'none,gemini-one'
  ])('rejects invalid backup configuration %s', (models) => {
    vi.stubEnv('GEMINI_FALLBACK_MODELS', models);
    expect(() => loadConfig()).toThrow('GEMINI_FALLBACK_MODELS');
  });
});
