const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

function delayMs(value: unknown): number {
  if (typeof value === 'string' && /^\d+(\.\d+)?s$/.test(value)) return Number(value.slice(0, -1)) * 1000;
  const duration = object(value);
  const seconds = Number(duration.seconds);
  const nanos = Number(duration.nanos ?? 0);
  return Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(nanos)
    ? seconds * 1000 + nanos / 1_000_000 : 0;
}

function untilPacificMidnight(now: number): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = (time: number) => Object.fromEntries(format.formatToParts(time).map(p => [p.type, Number(p.value)]));
  const today = parts(now);
  const target = Date.UTC(today.year, today.month - 1, today.day + 1);
  let candidate = target + 8 * 60 * 60_000;
  for (let i = 0; i < 3; i++) {
    const local = parts(candidate);
    candidate += target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  }
  return candidate - now;
}

export function modelCooldown(status: number, retryAfter: string | null, payload: unknown, now = Date.now()): number {
  const error = object(object(payload).error);
  const details = Array.isArray(error.details) ? error.details.map(object) : [];
  const daily = status === 429 && (
    /daily|per.?day/i.test(text(error.message) + ' ' + text(error.status)) ||
    details.some(detail => Array.isArray(detail.violations) && detail.violations.some(value => {
      const violation = object(value);
      return /per.?day|daily/i.test(text(violation.quotaId) + ' ' + text(violation.quotaMetric));
    }))
  );
  const headerDelay = retryAfter
    ? /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now
    : 0;
  const base = status === 404 ? 300_000 : status === 429 ? 60_000 : 30_000;
  // A fall-back DST day can be 25 hours. Only provider-supplied delays are capped.
  return Math.max(daily ? untilPacificMidnight(now) : 0, Math.min(86_400_000, Math.max(base,
    Number.isFinite(headerDelay) ? headerDelay : 0, ...details.map(detail => delayMs(detail.retryDelay)))));
}
