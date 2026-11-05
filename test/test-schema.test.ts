import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropOwnedTestSchema } from '../scripts/test-schema.mjs';

const schema = 'anitrack_browser_0123456789abcdef0123456789abcdef';
const database = () => ({
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  $disconnect: vi.fn().mockResolvedValue(undefined)
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Disposable database cleanup boundary', () => {
  it.each([
    ['public', true],
    ['anitrack_browser_invalid', true],
    [schema + '"; DROP SCHEMA public;--', true],
    [schema, false],
    [schema, undefined]
  ])('refuses an unsafe or unowned schema (%s, %s)', async (name, owned) => {
    const db = database();
    await expect(dropOwnedTestSchema(db, name, owned)).rejects.toThrow('ownership');
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('retries safely when a disconnect leaves the outcome of a DROP uncertain', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = database();
    db.$executeRawUnsafe.mockRejectedValueOnce(new Error('Connection lost after commit'));
    const cleanup = dropOwnedTestSchema(db, schema, true);
    await vi.runAllTimersAsync();
    await cleanup;
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(db.$executeRawUnsafe).toHaveBeenLastCalledWith('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1 FROM pg_namespace WHERE nspname = $1', schema);
  });

  it('reports failure if database verification keeps finding the schema', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = database();
    db.$queryRawUnsafe.mockResolvedValue([{ exists: 1 }]);
    const assertion = expect(dropOwnedTestSchema(db, schema, true)).rejects.toThrow('still exists');
    await vi.runAllTimersAsync();
    await assertion;
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(db.$disconnect).toHaveBeenCalledTimes(2);
  });
});
