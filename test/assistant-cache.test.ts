import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerationCache } from '../src/services/assistant-cache.js';
import { assistantInput, createGeminiInterpreter } from '../src/services/anime-assistant.js';

const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe('Assistant generation reuse', () => {
  it('coalesces concurrent loads and returns independent copies of validated results', async () => {
    const cache = createGenerationCache();
    const load = vi.fn().mockResolvedValue({ titles: ['One Piece'] });
    const [first, second] = await Promise.all([
      cache.run('hash', signal(), load), cache.run('hash', signal(), load)
    ]);
    first.titles.push('Modified by caller');
    expect(second.titles).toEqual(['One Piece']);
    expect(await cache.run('hash', signal(), load)).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared generation alive when one waiter cancels', async () => {
    const cache = createGenerationCache();
    let finish!: (value: string) => void;
    let shared!: AbortSignal;
    const load = vi.fn((value: AbortSignal) => {
      shared = value;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    const first = new AbortController();
    const failed = expect(cache.run('hash', first.signal, load)).rejects.toMatchObject({ name: 'AbortError' });
    const other = cache.run('hash', signal(), load);
    await Promise.resolve();
    first.abort();
    await failed;
    expect(shared.aborted).toBe(false);
    finish('verified answer');
    expect(await other).toBe('verified answer');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('aborts when the last waiter leaves and does not cache a late answer', async () => {
    const cache = createGenerationCache();
    const caller = new AbortController();
    let finish!: (value: string) => void;
    let shared!: AbortSignal;
    const load = vi.fn((value: AbortSignal) => {
      shared = value;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    const failed = expect(cache.run('hash', caller.signal, load)).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    caller.abort();
    await failed;
    expect(shared.aborted).toBe(true);
    finish('stale answer');
    await Promise.resolve();
    const replacement = vi.fn().mockResolvedValue('fresh answer');
    expect(await cache.run('hash', signal(), replacement)).toBe('fresh answer');
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('expires entries and evicts old entries at its capacity bound', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = createGenerationCache(1000, 2);
    const load = vi.fn().mockResolvedValue('answer');
    for (const key of ['a', 'b', 'c', 'a']) await cache.run(key, signal(), load);
    expect(load).toHaveBeenCalledTimes(4);
    await cache.run('a', signal(), load);
    expect(load).toHaveBeenCalledTimes(4);
    now = 1001;
    await cache.run('a', signal(), load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('does not cache failures or start work for an already cancelled caller', async () => {
    const cache = createGenerationCache();
    const load = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue('recovered');
    await expect(cache.run('hash', signal(), load)).rejects.toThrow('quota');
    expect(await cache.run('hash', signal(), load)).toBe('recovered');
    await expect(cache.run('other', AbortSignal.abort(), load)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not reserve quota again for repeated interpretation, but separates context and mode', async () => {
    const input = assistantInput.parse({ mode: 'recommend', message: 'Pirates with powers' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({
        relevant: true, summary: 'Pirates', question: '', titles: ['One Piece'], genres: [],
        excludeGenres: [], maxEpisodes: null, completedOnly: false, format: 'any'
      }) }] }]
    })));
    const reserve = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher, { reserve });
    await Promise.all([interpreter.plan(input, signal()), interpreter.plan(input, signal())]);
    await interpreter.plan({ ...input, excludeIds: ['12'] }, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    await interpreter.plan({ ...input, context: ['No long series'] }, signal());
    await interpreter.plan({ ...input, mode: 'identify' }, signal());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(reserve).toHaveBeenCalledTimes(3);
  });
});
