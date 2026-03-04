/**
 * Retry utility with exponential backoff and jitter.
 * No external dependencies — pure JS.
 */

const DEFAULT_OPTIONS = {
  maxAttempts: 2,
  baseDelayMs: 300,
  maxDelayMs: 3000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * @param {() => Promise<T>} fn - Async function to retry
 * @param {object} [options] - Retry options
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.baseDelayMs=500]
 * @param {number} [options.maxDelayMs=10000]
 * @param {(error: Error, attempt: number) => void} [options.onRetry]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options) {
  const { maxAttempts, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) {
        break;
      }

      if (options?.onRetry) {
        options.onRetry(lastError, attempt);
      }

      // Exponential backoff with jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      await sleep(delay);
    }
  }

  throw lastError;
}
