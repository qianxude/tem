export interface RateLimitConfig {
  requests: number;
  windowMs: number;
}

/**
 * Token bucket implementation for rate limiting.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private config: RateLimitConfig) {
    this.tokens = config.requests;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token. Returns a promise that resolves when a token is available.
   * Uses Bun.sleep for async delay if tokens need to be refilled.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    this.refill(now);

    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    // Calculate wait time for next token
    const tokensNeeded = 1 - this.tokens;
    const msPerToken = this.config.windowMs / this.config.requests;
    const waitMs = Math.ceil(tokensNeeded * msPerToken);

    await Bun.sleep(waitMs);

    // After waiting, recurse to try again (will refill and get token)
    return this.acquire();
  }

  /**
   * Refill tokens based on elapsed time since last check.
   */
  private refill(now: number): void {
    const elapsedMs = now - this.lastRefill;
    const tokensToAdd = (elapsedMs / this.config.windowMs) * this.config.requests;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.config.requests, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}
