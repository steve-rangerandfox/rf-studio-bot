/**
 * Fetch wrapper with automatic AbortController timeout.
 * Prevents any single API call from hanging indefinitely
 * and consuming the Cloudflare worker's execution budget.
 */

const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds

/**
 * @param {string|Request} url
 * @param {RequestInit & { timeoutMs?: number }} opts
 * @returns {Promise<Response>}
 */
export async function fetchT(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOpts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
