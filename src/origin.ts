import type { Config } from './config.js';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isTrustedOrigin(origin: string, config: Config): boolean {
  if (origin === config.CLIENT_ORIGIN) return true;
  if (config.NODE_ENV !== 'development') return false;
  try {
    const configured = new URL(config.CLIENT_ORIGIN);
    const requested = new URL(origin);
    return (
      requested.origin === origin &&
      configured.protocol === 'http:' &&
      requested.protocol === configured.protocol &&
      requested.port === configured.port &&
      loopbackHosts.has(configured.hostname) &&
      loopbackHosts.has(requested.hostname)
    );
  } catch {
    return false;
  }
}
