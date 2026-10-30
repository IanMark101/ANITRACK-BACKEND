import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export interface AccountMailer {
  available: boolean;
  send(to: string, purpose: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION', token: string): Promise<void>;
}

export function createAccountMailer(config: Config): AccountMailer {
  const transport = config.SMTP_HOST && config.MAIL_FROM ? nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE === '1',
    requireTLS: config.SMTP_SECURE !== '1',
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true
  }) : null;
  return {
    available: Boolean(transport),
    async send(to, purpose, token) {
      if (!transport) throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Account email is not configured yet. Please try again later.');
      const reset = purpose === 'PASSWORD_RESET';
      const url = new URL(reset ? '/reset-password' : '/verify-email', config.CLIENT_ORIGIN);
      // Fragments stay out of HTTP access logs and referrer headers.
      url.hash = new URLSearchParams({ token }).toString();
      try {
        await transport.sendMail({ from: config.MAIL_FROM, to,
          subject: reset ? 'Reset your AniTrack password' : 'Verify your AniTrack email',
          text: `${reset ? 'Reset your password' : 'Verify your email'}: ${url.href}\n\nThis link expires in ${reset ? '30 minutes' : '24 hours'}. If you did not request it, ignore this message.`
        });
      } catch {
        throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Account email is temporarily unavailable. Please try again later.');
      }
    }
  };
}
