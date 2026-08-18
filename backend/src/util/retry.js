import { isTransient } from './errors.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only failures classified as transient. A permission or validation failure is a
 * permanent answer — retrying it just makes the same wrong call again.
 *
 * `sleepFn` is injectable so tests exercise the backoff path without real waiting.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 200, maxMs = 4000, sleepFn = sleep, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jittered = Math.round(backoff * (0.5 + Math.random() / 2));
      onRetry?.({ attempt, delayMs: jittered, error: err });
      await sleepFn(jittered);
    }
  }
  throw lastErr;
}

export default withRetry;
