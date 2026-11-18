// Only validated generations enter this bounded, short-lived process-local cache.
// Callers supply hashes as keys; no prompts are stored on disk or in PostgreSQL.
export function createGenerationCache(ttl = 10 * 60_000, maximum = 128) {
  const values = new Map<string, { value: unknown; until: number }>();
  const pending = new Map<string, {
    controller: AbortController;
    waiters: number;
    promise: Promise<unknown>;
  }>();

  return {
    async run<T>(key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const cached = values.get(key);
      if (cached && cached.until > Date.now()) return structuredClone(cached.value) as T;
      values.delete(key);

      let job = pending.get(key);
      if (!job) {
        const controller = new AbortController();
        job = { controller, waiters: 0, promise: Promise.resolve() };
        const current = job;
        pending.set(key, current);
        current.promise = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return load(AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
        }).then(value => {
          if (!controller.signal.aborted) {
            for (const [entry, item] of values)
              if (item.until <= Date.now()) values.delete(entry);
            if (values.size >= maximum) values.delete(values.keys().next().value!);
            values.set(key, { value: structuredClone(value), until: Date.now() + ttl });
          }
          return value;
        }).finally(() => {
          if (pending.get(key) === current) pending.delete(key);
        });
      }
      const current = job;
      current.waiters++;
      return new Promise<T>((resolve, reject) => {
        let finished = false;
        const release = () => {
          if (finished) return false;
          finished = true;
          signal.removeEventListener('abort', abort);
          if (--current.waiters === 0 && pending.get(key) === current) {
            pending.delete(key);
            current.controller.abort();
          }
          return true;
        };
        const abort = () => { if (release()) reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        current.promise.then(
          value => { if (release()) resolve(structuredClone(value) as T); },
          error => { if (release()) reject(error); }
        );
      });
    }
  };
}
