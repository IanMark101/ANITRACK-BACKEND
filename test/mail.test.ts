import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn().mockResolvedValue({}) }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.create } }));
import { createAccountMailer } from '../src/services/mail.service.js';
import { testConfig } from './helpers.js';
afterEach(() => vi.clearAllMocks());
describe('Account email delivery', () => {
  it('fails clearly when SMTP is absent and never sends mail', async () => {
    const mail = createAccountMailer(testConfig);
    expect(mail.available).toBe(false);
    await expect(mail.send('unused@example.test', 'PASSWORD_RESET', 'a'.repeat(43))).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('requires TLS and uses the configured frontend origin with a fragment token', async () => {
    mocks.create.mockReturnValue({ sendMail: mocks.send });
    const mail = createAccountMailer({ ...testConfig, SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'noreply@example.test' });
    await mail.send('recipient@example.test', 'PASSWORD_RESET', 'a'.repeat(43));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, disableFileAccess: true, disableUrlAccess: true }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('http://localhost:5173/reset-password#token='), to: 'recipient@example.test' }));
  });
  it('uses the configured phone-reachable web origin for both account link purposes', async () => {
    mocks.create.mockReturnValue({ sendMail: mocks.send });
    const mail = createAccountMailer({ ...testConfig, SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'noreply@example.test', ACCOUNT_LINK_ORIGIN: 'http://192.168.1.20:5173' });
    await mail.send('recipient@example.test', 'PASSWORD_RESET', 'a'.repeat(43));
    await mail.send('recipient@example.test', 'EMAIL_VERIFICATION', 'b'.repeat(43));
    expect(mocks.send.mock.calls[0][0].text).toContain('http://192.168.1.20:5173/reset-password#token=');
    expect(mocks.send.mock.calls[1][0].text).toContain('http://192.168.1.20:5173/verify-email#token=');
  });
});
