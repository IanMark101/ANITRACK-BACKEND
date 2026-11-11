import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

beforeEach(() => {
  for (const [name, value] of Object.entries(testConfig)) vi.stubEnv(name, String(value));
  for (const name of ['BREVO_API_KEY', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) vi.stubEnv(name, '');
});

afterEach(() => vi.unstubAllEnvs());

describe('Account email configuration', () => {
  it('accepts a Brevo key with a sender and no SMTP settings', () => {
    vi.stubEnv('BREVO_API_KEY', 'test-brevo-key');
    vi.stubEnv('MAIL_FROM', 'sender@example.test');
    expect(loadConfig()).toMatchObject({ BREVO_API_KEY: 'test-brevo-key', MAIL_FROM: 'sender@example.test' });
  });

  it('rejects an HTTPS email configuration without a sender', () => {
    vi.stubEnv('BREVO_API_KEY', 'test-brevo-key');
    expect(() => loadConfig()).toThrow('Set MAIL_FROM to your verified Brevo sender.');
  });

  it('accepts HTTPS delivery while unused SMTP credentials are incomplete', () => {
    vi.stubEnv('BREVO_API_KEY', 'test-brevo-key');
    vi.stubEnv('MAIL_FROM', 'sender@example.test');
    vi.stubEnv('SMTP_USER', 'unused');
    expect(loadConfig().BREVO_API_KEY).toBe('test-brevo-key');
  });

  it('retains SMTP credential validation when the Brevo key is empty', () => {
    vi.stubEnv('SMTP_USER', 'sender@example.test');
    expect(() => loadConfig()).toThrow('Set both SMTP_USER and SMTP_PASSWORD.');
  });
});
