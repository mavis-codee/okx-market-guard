import { RateLimitError, SafetyError } from './errors.ts';

export interface RateLimiter {
  acquire(): Promise<void>;
}

/**
 * Token bucket. Default is conservative vs OKX public endpoints
 * (most market/public routes allow ~20 requests / 2 seconds per IP).
 * Default: 8 requests/second, burst 16.
 */
export class TokenBucket implements RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private pending = 0;

  constructor(ratePerSec = 8, burst = 16) {
    if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
      throw new SafetyError('ratePerSec must be a positive number');
    }
    if (!Number.isInteger(burst) || burst < 1) {
      throw new SafetyError('burst must be a positive integer');
    }
    this.capacity = burst;
    this.refillPerMs = ratePerSec / 1000;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    // Simple serialized queue keeps the bucket correct without a timer wheel.
    while (true) {
      const waiter = this.tryTake();
      if (waiter === 0) return;
      await sleep(waiter);
    }
  }

  private tryTake(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const needed = 1 - this.tokens;
    return Math.ceil(needed / this.refillPerMs);
  }

  /** Test/debug snapshot. */
  snapshot(): { tokens: number; capacity: number } {
    return { tokens: this.tokens, capacity: this.capacity };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function rejectNeverCredentials(opts: Record<string, unknown>): void {
  const banned = ['apiKey', 'api_key', 'secret', 'secretKey', 'passphrase', 'password', 'token'];
  for (const k of Object.keys(opts)) {
    if (banned.includes(k)) {
      throw new SafetyError(
        `okx-market-guard is public read-only and does not accept "${k}". No keys, no orders, no account access.`,
      );
    }
  }
}
