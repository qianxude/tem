import type * as i from './types';

/**
 * Rate limiter with tryAcquire pattern for immediate reject/allow decision.
 * Uses token bucket algorithm.
 */
class RejectingRateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private limit: number, private windowMs: number) {
    this.tokens = limit;
    this.lastRefill = Date.now();
  }

  /**
   * Try to acquire a token. Returns immediately with success/failure.
   */
  tryAcquire(): boolean {
    const now = Date.now();
    this.refill(now);

    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }

    return false;
  }

  private refill(now: number): void {
    const elapsedMs = now - this.lastRefill;
    const tokensToAdd = (elapsedMs / this.windowMs) * this.limit;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.limit, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}

/**
 * Mock service with concurrency and rate limiting.
 */
export class MockService {
  private currentConcurrency = 0;
  private rateLimiter: RejectingRateLimiter;

  constructor(
    public name: string,
    private config: i.ServiceConfig
  ) {
    this.rateLimiter = new RejectingRateLimiter(
      config.rateLimit.limit,
      config.rateLimit.windowMs
    );
  }

  /**
   * Try to acquire both concurrency slot and rate limit token.
   * Returns immediately with result - no waiting.
   */
  tryAcquire(): i.TryAcquireResult {
    // Check concurrency first
    if (this.currentConcurrency >= this.config.maxConcurrency) {
      return { allowed: false, error: 'concurrency' };
    }

    // Then check rate limit
    if (!this.rateLimiter.tryAcquire()) {
      return { allowed: false, error: 'rateLimit' };
    }

    // Both passed - acquire concurrency
    this.currentConcurrency++;
    return { allowed: true };
  }

  /**
   * Release a concurrency slot.
   */
  release(): void {
    if (this.currentConcurrency > 0) {
      this.currentConcurrency--;
    }
  }

  /**
   * Get random delay within configured range.
   */
  getDelay(): number {
    const [min, max] = this.config.delayMs;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Get current concurrency count.
   */
  getCurrentConcurrency(): number {
    return this.currentConcurrency;
  }
}
