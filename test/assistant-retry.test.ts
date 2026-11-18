import { describe, expect, it } from 'vitest';
import { modelCooldown } from '../src/services/assistant-retry.js';

describe('Provider quota cooldowns', () => {
  it('reads RetryInfo durations as strings and protobuf objects', () => {
    expect(modelCooldown(429, null, { error: { details: [{ retryDelay: '125.5s' }] } })).toBe(125500);
    expect(modelCooldown(429, '120', { error: { details: [{ retryDelay: { seconds: '180', nanos: 500000000 } }] } })).toBe(180500);
  });
  it.each([
    ['2026-11-18T09:00:00Z', '2026-11-19T08:00:00Z'],
    ['2026-07-18T09:00:00Z', '2026-07-19T07:00:00Z'],
    ['2026-03-08T08:30:00Z', '2026-03-09T07:00:00Z'],
    ['2026-11-01T07:30:00Z', '2026-11-02T08:00:00Z']
  ])('keeps a daily-limited model paused until Pacific midnight from %s', (now, reset) => {
    const payload = { error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
    expect(modelCooldown(429, null, payload, Date.parse(now))).toBe(Date.parse(reset) - Date.parse(now));
  });
  it('recognizes daily quota messages and bounds untrusted retry delays', () => {
    const now = Date.parse('2026-11-18T09:00:00Z');
    expect(modelCooldown(429, null, { error: { message: 'Daily quota exceeded' } }, now)).toBe(23 * 60 * 60_000);
    expect(modelCooldown(429, '999999999999', {})).toBe(86400000);
    expect(modelCooldown(429, 'invalid', { error: { details: [{ retryDelay: { seconds: 'invalid' } }] } })).toBe(60000);
    expect(modelCooldown(503, null, null)).toBe(30000);
  });
});
