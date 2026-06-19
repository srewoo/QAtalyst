/**
 * Tests for rate-limiter.js — RateLimiter class. Imported directly via the real
 * module.exports so v8 measures coverage of the shipped source.
 */
import { vi } from 'vitest';
const { RateLimiter, getRateLimiter } = require('../rate-limiter.js');

function newLimiter(opts) {
  return new RateLimiter(opts);
}

describe('RateLimiter — construction & defaults', () => {
  test('applies sensible defaults', () => {
    const rl = newLimiter();
    expect(rl.requestsPerMinute).toBe(60);
    expect(rl.maxConcurrent).toBe(5);
    expect(rl.retryAttempts).toBe(3);
    expect(rl.baseBackoffMs).toBe(1000);
  });

  test('honors supplied options', () => {
    const rl = newLimiter({ requestsPerMinute: 10, maxConcurrent: 2, retryAttempts: 1, baseBackoffMs: 500 });
    expect(rl.requestsPerMinute).toBe(10);
    expect(rl.maxConcurrent).toBe(2);
    expect(rl.retryAttempts).toBe(1);
    expect(rl.baseBackoffMs).toBe(500);
  });
});

describe('RateLimiter.execute — happy path', () => {
  test('runs the function and resolves its result', async () => {
    const rl = newLimiter();
    const result = await rl.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(rl.requestTimestamps.length).toBe(1);
    // execute() resolves the result before its .finally() decrements the
    // counter; flush one more microtask so the decrement lands.
    await Promise.resolve();
    expect(rl.activeRequests).toBe(0);
  });

  test('rejects when the function throws and retries are exhausted', async () => {
    // NOTE: constructor uses `options.retryAttempts || 3`, so 0 is coerced to 3.
    // Use 1 retry and fake timers to fast-forward the backoff sleep.
    vi.useFakeTimers();
    try {
      const rl = newLimiter({ retryAttempts: 1 });
      let attempts = 0;
      const p = rl.execute(async () => { attempts++; throw new Error('boom'); });
      const assertion = expect(p).rejects.toThrow('boom');
      await vi.runAllTimersAsync();
      await assertion;
      expect(attempts).toBe(2); // initial try + 1 retry
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RateLimiter.calculateBackoff — exponential growth', () => {
  test('grows exponentially from the base, capped at 60s', () => {
    const rl = newLimiter({ baseBackoffMs: 1000 });
    // jitter is 0-20%, so assert ranges. base * 2^(attempt-1)
    const a1 = rl.calculateBackoff(1); // ~1000-1200
    const a2 = rl.calculateBackoff(2); // ~2000-2400
    const a3 = rl.calculateBackoff(3); // ~4000-4800
    expect(a1).toBeGreaterThanOrEqual(1000);
    expect(a1).toBeLessThanOrEqual(1200);
    expect(a2).toBeGreaterThanOrEqual(2000);
    expect(a2).toBeLessThanOrEqual(2400);
    expect(a3).toBeGreaterThanOrEqual(4000);
    expect(a3).toBeLessThanOrEqual(4800);
    // very high attempt is capped at 60s
    expect(rl.calculateBackoff(20)).toBe(60000);
  });
});

describe('RateLimiter.isRateLimitError', () => {
  test('detects 429 by status / statusCode / message', () => {
    const rl = newLimiter();
    expect(rl.isRateLimitError({ status: 429 })).toBe(true);
    expect(rl.isRateLimitError({ statusCode: 429 })).toBe(true);
    expect(rl.isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
    expect(rl.isRateLimitError(new Error('too many requests'))).toBe(true);
    expect(rl.isRateLimitError(new Error('429 nope'))).toBe(true);
  });

  test('returns false for null / unrelated errors', () => {
    const rl = newLimiter();
    expect(rl.isRateLimitError(null)).toBe(false);
    expect(rl.isRateLimitError(new Error('something else'))).toBe(false);
  });
});

describe('RateLimiter.getRetryAfterFromError', () => {
  test('parses Retry-After seconds into milliseconds', () => {
    const rl = newLimiter();
    const err = { response: { headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '5' : null) } } };
    expect(rl.getRetryAfterFromError(err)).toBe(5000);
  });

  test('returns null when no header present', () => {
    const rl = newLimiter();
    expect(rl.getRetryAfterFromError(new Error('x'))).toBeNull();
  });
});

describe('RateLimiter.canMakeRequest — sliding window throttle', () => {
  test('returns false once the per-minute budget is full', () => {
    const rl = newLimiter({ requestsPerMinute: 2 });
    const now = Date.now();
    rl.requestTimestamps = [now, now];
    expect(rl.canMakeRequest()).toBe(false);
  });

  test('prunes timestamps older than one minute and allows again', () => {
    const rl = newLimiter({ requestsPerMinute: 2 });
    const old = Date.now() - 61000;
    rl.requestTimestamps = [old, old];
    expect(rl.canMakeRequest()).toBe(true);
    // the stale timestamps were pruned
    expect(rl.requestTimestamps.length).toBe(0);
  });
});

describe('RateLimiter retry/backoff with fake timers', () => {
  test('retries a 429 failure then succeeds, sleeping between attempts', async () => {
    vi.useFakeTimers();
    try {
      const rl = newLimiter({ retryAttempts: 3, baseBackoffMs: 1000 });
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) { const e = new Error('rate limit'); e.status = 429; throw e; }
        return 'recovered';
      };
      const p = rl.execute(fn);
      // drive all pending timers (the backoff sleep) to completion
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe('recovered');
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RateLimiter.getStatus & clear', () => {
  test('reports queue/active/window state', () => {
    const rl = newLimiter();
    rl.requestTimestamps = [Date.now()];
    const s = rl.getStatus();
    expect(s).toMatchObject({ queueLength: 0, activeRequests: 0, requestsInLastMinute: 1 });
    expect(typeof s.canMakeRequest).toBe('boolean');
  });

  test('clear resets all state', () => {
    const rl = newLimiter();
    rl.queue = [{}];
    rl.activeRequests = 2;
    rl.requestTimestamps = [1, 2, 3];
    rl.processing = true;
    rl.clear();
    expect(rl.queue).toEqual([]);
    expect(rl.activeRequests).toBe(0);
    expect(rl.requestTimestamps).toEqual([]);
    expect(rl.processing).toBe(false);
  });
});
