import { describe, expect, it } from 'bun:test';
import { RateLimiter } from '../../src/utils/rate-limiter.js';

describe('RateLimiter', () => {
  describe('token bucket refill logic', () => {
    it('should start with full bucket', async () => {
      const limiter = new RateLimiter({ requests: 5, windowMs: 1000 });

      // First 5 should be immediate
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50); // Should be near immediate
    });

    it('should refill tokens over time', async () => {
      const windowMs = 200;
      const limiter = new RateLimiter({ requests: 2, windowMs });

      // Exhaust tokens
      await limiter.acquire();
      await limiter.acquire();

      // Wait for refill
      await Bun.sleep(windowMs);

      // Should be able to acquire again (near immediate)
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('should not exceed max tokens', async () => {
      const limiter = new RateLimiter({ requests: 3, windowMs: 100 });

      // Exhaust tokens
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();

      // Wait longer than needed for refill
      await Bun.sleep(300);

      // First acquisition after wait should be immediate (bucket full)
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('rate limiting accuracy', () => {
    it('should limit to specified requests per window', async () => {
      const windowMs = 300;
      const requests = 3;
      const limiter = new RateLimiter({ requests, windowMs });

      const timestamps: number[] = [];

      // Make more requests than allowed per window
      for (let i = 0; i < requests + 2; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }

      // First 3 should be quick
      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];

      expect(gap1).toBeLessThan(50);
      expect(gap2).toBeLessThan(50);

      // 4th should wait for refill (approximately windowMs/requests per token)
      const gap3 = timestamps[3] - timestamps[2];
      expect(gap3).toBeGreaterThan(windowMs / requests - 20); // Allow some tolerance
    });

    it('should maintain average rate over time', async () => {
      const windowMs = 500;
      const requests = 5;
      const limiter = new RateLimiter({ requests, windowMs });

      const timestamps: number[] = [];
      const totalRequests = 10;

      const start = Date.now();
      for (let i = 0; i < totalRequests; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }
      const totalElapsed = Date.now() - start;

      // Should take approximately (totalRequests - requests) * (windowMs / requests) time
      // First 5 are free, remaining 5 need to wait
      const expectedMinTime = (totalRequests - requests) * (windowMs / requests) * 0.5;
      expect(totalElapsed).toBeGreaterThan(expectedMinTime);
    });

    it('should enforce spacing between requests at high rates', async () => {
      const limiter = new RateLimiter({ requests: 10, windowMs: 100 });

      const timestamps: number[] = [];

      for (let i = 0; i < 15; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }

      // Check that after initial burst, subsequent requests are spaced
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]);

      // After the first 10 (burst), there should be delays
      const avgGapAfterBurst = gaps.slice(10).reduce((a, b) => a + b, 0) / gaps.slice(10).length;

      expect(avgGapAfterBurst).toBeGreaterThan(5); // At least some delay
    });
  });

  describe('burst handling', () => {
    it('should allow burst up to bucket size', async () => {
      const limiter = new RateLimiter({ requests: 10, windowMs: 1000 });

      const timestamps: number[] = [];

      // Burst of 10 should all be fast
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }

      const totalBurstTime = timestamps[9] - timestamps[0];
      expect(totalBurstTime).toBeLessThan(50);
    });

    it('should smooth traffic after burst', async () => {
      const windowMs = 200;
      const requests = 4;
      const limiter = new RateLimiter({ requests, windowMs });

      // Initial burst
      for (let i = 0; i < requests; i++) {
        await limiter.acquire();
      }

      // Wait for partial refill
      await Bun.sleep(windowMs / 2);

      // Should be able to get some tokens back
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      // Should be relatively quick since some tokens refilled
      expect(elapsed).toBeLessThan(windowMs);
    });

    it('should handle rapid sequential calls', async () => {
      const limiter = new RateLimiter({ requests: 5, windowMs: 100 });

      // Fire many acquires rapidly
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 8; i++) {
        promises.push(limiter.acquire());
      }

      // All should complete, but last ones should take longer
      const start = Date.now();
      await Promise.all(promises);
      const totalTime = Date.now() - start;

      // Should take some time due to rate limiting (8 - 5 = 3 extra)
      // Each extra needs about windowMs/requests = 20ms
      expect(totalTime).toBeGreaterThan(30); // Some time for rate limiting
    });
  });

  describe('edge cases', () => {
    it('should handle single request limit', async () => {
      const limiter = new RateLimiter({ requests: 1, windowMs: 100 });

      // First should be immediate
      await limiter.acquire();

      // Second should wait
      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThan(50); // Should have waited
    });

    it('should handle large windows', async () => {
      const limiter = new RateLimiter({ requests: 5, windowMs: 5000 });

      // Should allow burst
      const timestamps: number[] = [];
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }

      expect(timestamps[4] - timestamps[0]).toBeLessThan(50);
    });

    it('should handle many requests', async () => {
      const limiter = new RateLimiter({ requests: 100, windowMs: 1000 });

      const timestamps: number[] = [];

      for (let i = 0; i < 110; i++) {
        await limiter.acquire();
        timestamps.push(Date.now());
      }

      // First 100 should be quick
      const burstTime = timestamps[99] - timestamps[0];
      expect(burstTime).toBeLessThan(100);

      // All should complete
      expect(timestamps.length).toBe(110);
    });
  });
});
