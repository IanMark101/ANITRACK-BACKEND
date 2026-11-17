import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantInput, createAnimeAssistant, createGeminiInterpreter } from '../src/services/anime-assistant.js';

const input = assistantInput.parse({ mode: 'recommend', message: 'Adventure' });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockTimeouts() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Request deadline', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
}

describe('Assistant request deadlines', () => {
  it('ends a stalled interpretation in 25 seconds and releases search capacity', async () => {
    mockTimeouts();
    const interpreter = { plan: vi.fn().mockReturnValue(new Promise(() => {})), rank: vi.fn() };
    const service = createAnimeAssistant({ search: vi.fn() }, interpreter);
    const failure = expect(service.run(input)).rejects.toMatchObject({ code: 'ASSISTANT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25000);
    await failure;
    expect(interpreter.rank).not.toHaveBeenCalled();
    interpreter.plan.mockResolvedValue({
      relevant: false, summary: '', question: 'Which adventure?', titles: [], genres: [],
      excludeGenres: [], maxEpisodes: null, completedOnly: false, format: 'any'
    });
    const results = await Promise.all([service.run(input), service.run(input), service.run(input)]);
    expect(results.every(result => result.items.length === 0)).toBe(true);
  });

  it('stops a stalled model attempt after eight seconds even if the fetcher ignores cancellation', async () => {
    mockTimeouts();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {}));
    const interpreter = createGeminiInterpreter({
      GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODELS: 'none'
    }, fetcher);
    const failure = expect(interpreter.plan(input, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ASSISTANT_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(8000);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows cancellation while database usage reservation is stalled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reserve = vi.fn().mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const interpreter = createGeminiInterpreter({ GEMINI_API_KEY: 'test-key' }, fetcher, { reserve });
    const failure = expect(interpreter.plan(input, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await failure;
    expect(fetcher).not.toHaveBeenCalled();
  });
});
