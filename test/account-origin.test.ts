import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrustedOrigin } from '../src/origin.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

beforeEach(() => {
  for (const [name, value] of Object.entries(testConfig)) vi.stubEnv(name, String(value));
  vi.stubEnv('GEMINI_FALLBACK_MODELS', 'none');
  vi.stubEnv('ACCOUNT_LINK_ORIGIN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Account link origins', () => {
  it('trusts only the explicitly configured web origin while retaining localhost', () => {
    const config = { ...testConfig, ACCOUNT_LINK_ORIGIN: 'http://192.168.1.20:5173' };
    expect(isTrustedOrigin(config.CLIENT_ORIGIN, config)).toBe(true);
    expect(isTrustedOrigin(config.ACCOUNT_LINK_ORIGIN, config)).toBe(true);
    expect(isTrustedOrigin('http://192.168.1.21:5173', config)).toBe(false);
    expect(isTrustedOrigin('http://192.168.1.20:5174', config)).toBe(false);
    expect(isTrustedOrigin('http://192.168.1.20:5173.attacker.test', config)).toBe(false);
  });
  it.each(['file:///tmp', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?query=yes', 'https://example.test#fragment'])('rejects an unsafe origin %s', value => {
    vi.stubEnv('ACCOUNT_LINK_ORIGIN', value);
    expect(() => loadConfig()).toThrow('ACCOUNT_LINK_ORIGIN');
  });
  it('requires HTTPS for production account links', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CLIENT_ORIGIN', 'https://anitrack.example.test');
    vi.stubEnv('ACCOUNT_LINK_ORIGIN', 'http://anitrack.example.test');
    expect(() => loadConfig()).toThrow('must use HTTPS');
    vi.stubEnv('ACCOUNT_LINK_ORIGIN', 'https://accounts.example.test');
    expect(loadConfig().ACCOUNT_LINK_ORIGIN).toBe('https://accounts.example.test');
  });
});
