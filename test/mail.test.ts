import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn().mockResolvedValue({}) }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.create } }));
import { createAccountMailer } from '../src/services/mail.service.js';
import { testConfig } from './helpers.js';
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
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
  it.each([
    ['EMAIL_VERIFICATION', '/verify-email', 'Verify your AniTrack email', '24 hours'],
    ['PASSWORD_RESET', '/reset-password', 'Reset your AniTrack password', '30 minutes']
  ] as const)('sends %s through HTTPS with the correct account link', async (purpose, path, subject, expiry) => {
    const response = new Response('{"messageId":"test-message"}', { status: 201 });
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', request);
    const mail = createAccountMailer({
      ...testConfig,
      BREVO_API_KEY: 'test-brevo-key',
      MAIL_FROM: 'sender@example.test',
      ACCOUNT_LINK_ORIGIN: 'https://anitrack.example.test'
    });
    expect(mail.available).toBe(true);
    await mail.send('recipient@example.test', purpose, 'a'.repeat(43));
    expect(request).toHaveBeenCalledOnce();
    const [endpoint, options] = request.mock.calls[0];
    expect(endpoint).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'api-key': 'test-brevo-key', 'content-type': 'application/json' },
      signal: expect.any(AbortSignal),
      redirect: 'error'
    });
    const message = JSON.parse(options.body);
    expect(message).toMatchObject({
      sender: { name: 'AniTrack', email: 'sender@example.test' },
      to: [{ email: 'recipient@example.test' }],
      subject
    });
    expect(message.textContent).toContain(`https://anitrack.example.test${path}#token=${'a'.repeat(43)}`);
    expect(message.textContent).toContain(expiry);
    expect(message.textContent).not.toContain('?token=');
    expect(response.bodyUsed).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('selects HTTPS delivery when SMTP settings are also present', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', request);
    const mail = createAccountMailer({
      ...testConfig,
      BREVO_API_KEY: 'test-brevo-key',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'unused',
      SMTP_PASSWORD: 'unused',
      MAIL_FROM: 'sender@example.test'
    });
    await mail.send('recipient@example.test', 'EMAIL_VERIFICATION', 'a'.repeat(43));
    expect(request).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('requires a sender before enabling HTTPS delivery', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const mail = createAccountMailer({ ...testConfig, BREVO_API_KEY: 'test-brevo-key' });
    expect(mail.available).toBe(false);
    await expect(mail.send('recipient@example.test', 'EMAIL_VERIFICATION', 'a'.repeat(43)))
      .rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])('reports provider HTTP %s as a recoverable failure without sending through SMTP', async (status) => {
    const response = new Response('provider response containing private details', { status });
    const request = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', request);
    const mail = createAccountMailer({
      ...testConfig,
      BREVO_API_KEY: 'test-brevo-key',
      SMTP_HOST: 'smtp.example.test',
      MAIL_FROM: 'sender@example.test'
    });
    await expect(mail.send('recipient@example.test', 'PASSWORD_RESET', 'a'.repeat(43)))
      .rejects.toMatchObject({
        status: 503,
        code: 'EMAIL_UNAVAILABLE',
        message: 'Account email is temporarily unavailable. Please try again later.'
      });
    expect(request).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('maps network and timeout failures to the account email error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Private provider details', 'TimeoutError')));
    const mail = createAccountMailer({ ...testConfig, BREVO_API_KEY: 'test-brevo-key', MAIL_FROM: 'sender@example.test' });
    await expect(mail.send('recipient@example.test', 'EMAIL_VERIFICATION', 'a'.repeat(43)))
      .rejects.toMatchObject({
        code: 'EMAIL_UNAVAILABLE',
        message: 'Account email is temporarily unavailable. Please try again later.'
      });
  });
});
