const RETRY_DELAYS_MS = [1_000, 3_000] as const;

// Each attempt must capture a fresh snapshot and release its own source locks.
export async function retrySourceSynchronization<T>(options: {
  synchronize: () => Promise<T>;
  onRetry: (attempt: number, delayMilliseconds: number, error: unknown) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try { return await options.synchronize(); }
    catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      options.onRetry(attempt + 1, delay, error);
      await wait(delay);
    }
  }
}
