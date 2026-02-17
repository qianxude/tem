import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TEM } from '../../src/core/tem.js';
import { startMockServer, stopMockServer } from '../../src/mock-server/index.js';

const TEST_PORT = 19997;
const MOCK_URL = `http://localhost:${TEST_PORT}`;

// Helper to create a configured mock service
async function createMockService(
  name: string,
  config: {
    maxConcurrency: number;
    rateLimit: { limit: number; windowMs: number };
    delayMs: [number, number];
  }
): Promise<string> {
  const res = await fetch(`${MOCK_URL}/service/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  expect(res.status).toBe(201);
  return name;
}

describe('TEM.detectConstraints Integration', () => {
  beforeEach(() => {
    // Start mock server in multi mode
    startMockServer({ port: TEST_PORT, mode: 'multi' });
  });

  afterEach(() => {
    // Stop mock server
    stopMockServer();
  });

  describe('Concurrency Detection', () => {
    it('should detect concurrency limit with 80% safety margin applied', async () => {
      // Create service with maxConcurrency: 5, high rate limit
      await createMockService('concurrency-test', {
        maxConcurrency: 5,
        rateLimit: { limit: 1000, windowMs: 1000 }, // Very high rate limit
        delayMs: [10, 20],
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/concurrency-test`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 1000, // Short duration since we're testing concurrency
      });

      // Verify structure
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.rateLimit).toBeDefined();
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(1);
      expect(result.rateLimit.windowMs).toBeGreaterThanOrEqual(1000);
      expect(result.confidence).toMatch(/^(high|medium|low)$/);
      expect(Array.isArray(result.notes)).toBe(true);

      // With maxConcurrency: 5, detection should find ~5, then apply 80% margin -> ~4
      // Allow ±1 for detection variance (design: 5, expected after margin: 4, range: 3-5)
      expect(result.concurrency).toBeGreaterThanOrEqual(3);
      expect(result.concurrency).toBeLessThanOrEqual(5);

      // Confidence should be medium or high for successful detection
      expect(['medium', 'high']).toContain(result.confidence);

      console.log('[TEST] Concurrency detection result:', {
        detected: result.concurrency,
        designed: 5,
        expectedAfterMargin: 4,
        confidence: result.confidence,
        notes: result.notes,
      });
    });

    it('should detect low concurrency limits accurately', async () => {
      // Test with very low concurrency
      await createMockService('low-concurrency-test', {
        maxConcurrency: 2,
        rateLimit: { limit: 1000, windowMs: 1000 },
        delayMs: [10, 20],
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/low-concurrency-test`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 1000,
      });

      // With maxConcurrency: 2, detection should find ~2, then apply 80% margin -> ~1 or 2
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.concurrency).toBeLessThanOrEqual(3);

      console.log('[TEST] Low concurrency detection result:', {
        detected: result.concurrency,
        designed: 2,
        confidence: result.confidence,
      });
    });
  });

  describe('Rate Limit Detection', () => {
    it('should detect high rate limits with no rate limit hits', async () => {
      // Create service with high concurrency and no practical rate limit
      // When no rate limits are hit, algorithm estimates based on throughput
      await createMockService('no-rate-limit-test', {
        maxConcurrency: 10,
        rateLimit: { limit: 1000, windowMs: 1000 }, // Very high - won't be hit
        delayMs: [5, 10], // Fast responses
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/no-rate-limit-test`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 2000,
      });

      // With high rate limit, we won't hit rate limits
      // Algorithm estimates based on throughput with 60s window
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(100);
      expect(result.rateLimit.windowMs).toBe(60000);

      console.log('[TEST] No rate limit hit result:', {
        detectedRequests: result.rateLimit.requests,
        detectedWindowMs: result.rateLimit.windowMs,
        confidence: result.confidence,
        notes: result.notes,
      });
    });

    it('should detect moderate rate limit when hit', async () => {
      // Use low rate limit so it's definitely hit during detection
      // With low concurrency (3), safe concurrency = 2
      // Rate limit 5 per 1000ms means we'll hit it quickly
      await createMockService('moderate-rate-limit', {
        maxConcurrency: 3,
        rateLimit: { limit: 5, windowMs: 1000 },
        delayMs: [5, 10],
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/moderate-rate-limit`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 3000, // 3 windows
      });

      // Should detect rate limit was hit
      // With concurrency 3, safe = 2, rate limit 5/window
      // We should be able to make ~5 requests per window before hitting limit
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(2);
      expect(result.rateLimit.requests).toBeLessThanOrEqual(10);
      expect(result.rateLimit.windowMs).toBe(1000);

      console.log('[TEST] Moderate rate limit result:', {
        detectedRequests: result.rateLimit.requests,
        designedRequests: 5,
        detectedWindowMs: result.rateLimit.windowMs,
        confidence: result.confidence,
        notes: result.notes,
      });
    });
  });

  describe('Combined Constraints Detection', () => {
    it('should detect both concurrency and rate limit', async () => {
      // Use values that allow clear detection
      // Low concurrency so we can detect it
      // Low rate limit so we hit it
      await createMockService('combined-test', {
        maxConcurrency: 3,
        rateLimit: { limit: 6, windowMs: 1000 },
        delayMs: [10, 20],
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/combined-test`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 3000,
      });

      // Concurrency: design 3, expected after 80% margin: ~2
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.concurrency).toBeLessThanOrEqual(3);

      // Rate limit: should detect something reasonable
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(2);
      expect(result.rateLimit.requests).toBeLessThanOrEqual(12);

      // Window should be detected as 1000ms (closest common window)
      expect(result.rateLimit.windowMs).toBe(1000);

      // Confidence should be medium or high
      expect(['medium', 'high']).toContain(result.confidence);

      console.log('[TEST] Combined detection result:', {
        concurrency: {
          detected: result.concurrency,
          designed: 3,
        },
        rateLimit: {
          detectedRequests: result.rateLimit.requests,
          designedRequests: 6,
          detectedWindowMs: result.rateLimit.windowMs,
          designedWindowMs: 1000,
        },
        confidence: result.confidence,
        notes: result.notes,
      });
    });

    it('should handle strict combined constraints', async () => {
      // Strict: both low concurrency and low rate limit
      await createMockService('strict-combined', {
        maxConcurrency: 2,
        rateLimit: { limit: 4, windowMs: 1000 },
        delayMs: [10, 20],
      });

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/strict-combined`,
        method: 'GET',
        timeoutMs: 10000,
        rateLimitTestDurationMs: 3000,
      });

      // Should still detect reasonable values
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.concurrency).toBeLessThanOrEqual(3);
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(2);
      expect(result.rateLimit.requests).toBeLessThanOrEqual(8);

      console.log('[TEST] Strict combined detection result:', {
        concurrency: result.concurrency,
        rateLimit: result.rateLimit.requests,
        confidence: result.confidence,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent endpoint gracefully', async () => {
      // Use a very short timeout for faster failure
      const startTime = Date.now();

      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/nonexistent-service`,
        method: 'GET',
        timeoutMs: 5000,
        rateLimitTestDurationMs: 1000,
      });

      const elapsed = Date.now() - startTime;

      // Should complete within timeout
      expect(elapsed).toBeLessThan(6000);

      // Should return conservative defaults due to failures
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(1);
      expect(result.confidence).toBeDefined();
      expect(Array.isArray(result.notes)).toBe(true);

      // Should have notes indicating issues
      const hasIssueNotes = result.notes.some(
        (note) =>
          note.includes('conservative') ||
          note.includes('error') ||
          note.includes('limit') ||
          note.includes('detected')
      );
      expect(hasIssueNotes).toBe(true);

      console.log('[TEST] Non-existent endpoint result:', {
        concurrency: result.concurrency,
        rateLimit: result.rateLimit,
        confidence: result.confidence,
        notes: result.notes,
        elapsedMs: elapsed,
      });
    });

    it('should handle very short timeout', async () => {
      await createMockService('timeout-test', {
        maxConcurrency: 5,
        rateLimit: { limit: 20, windowMs: 1000 },
        delayMs: [50, 100], // Slower responses
      });

      const startTime = Date.now();

      // Very short timeout should still complete (tests use their own internal timeouts)
      const result = await TEM.detectConstraints({
        url: `${MOCK_URL}/mock/timeout-test`,
        method: 'GET',
        timeoutMs: 2000, // Very short
        rateLimitTestDurationMs: 500,
      });

      const elapsed = Date.now() - startTime;

      // Should complete quickly
      expect(elapsed).toBeLessThan(5000);

      // Should return some configuration
      expect(result.concurrency).toBeGreaterThanOrEqual(1);
      expect(result.rateLimit.requests).toBeGreaterThanOrEqual(1);

      console.log('[TEST] Short timeout result:', {
        concurrency: result.concurrency,
        rateLimit: result.rateLimit,
        confidence: result.confidence,
        elapsedMs: elapsed,
      });
    });
  });

  describe('Detection Accuracy Thresholds', () => {
    it('should detect concurrency within acceptable variance', async () => {
      const testCases = [
        { concurrency: 3, rateLimit: 20, windowMs: 1000 },
        { concurrency: 5, rateLimit: 30, windowMs: 1000 },
        { concurrency: 8, rateLimit: 50, windowMs: 1000 },
      ];

      for (const testCase of testCases) {
        const serviceName = `concurrency-accuracy-${testCase.concurrency}`;

        await createMockService(serviceName, {
          maxConcurrency: testCase.concurrency,
          rateLimit: { limit: testCase.rateLimit, windowMs: testCase.windowMs },
          delayMs: [5, 15],
        });

        const result = await TEM.detectConstraints({
          url: `${MOCK_URL}/mock/${serviceName}`,
          method: 'GET',
          timeoutMs: 10000,
          rateLimitTestDurationMs: 2000,
        });

        // Verify concurrency within ±1 of designed (after 80% margin)
        const expectedConcurrency = Math.floor(testCase.concurrency * 0.8);
        const concurrencyDiff = Math.abs(result.concurrency - expectedConcurrency);

        console.log(`[TEST] Concurrency accuracy ${testCase.concurrency}:`, {
          detected: result.concurrency,
          designed: testCase.concurrency,
          expected: expectedConcurrency,
          diff: concurrencyDiff,
          confidence: result.confidence,
        });

        // Assert concurrency threshold: ±1 of expected
        expect(concurrencyDiff).toBeLessThanOrEqual(1);

        // Confidence should be medium or high
        expect(['medium', 'high']).toContain(result.confidence);
      }
    }, 30000);

    it('should detect rate limits within acceptable variance', async () => {
      // Test with low rate limits that will definitely be hit
      // Need: concurrency high enough to hit rate limit, but rate limit low enough to trigger
      const testCases = [
        { concurrency: 3, rateLimit: 5, windowMs: 1000 },
        { concurrency: 4, rateLimit: 8, windowMs: 1000 },
        { concurrency: 5, rateLimit: 10, windowMs: 1000 },
      ];

      for (const testCase of testCases) {
        const serviceName = `rate-accuracy-${testCase.rateLimit}`;

        await createMockService(serviceName, {
          maxConcurrency: testCase.concurrency,
          rateLimit: { limit: testCase.rateLimit, windowMs: testCase.windowMs },
          delayMs: [5, 10],
        });

        const result = await TEM.detectConstraints({
          url: `${MOCK_URL}/mock/${serviceName}`,
          method: 'GET',
          timeoutMs: 10000,
          rateLimitTestDurationMs: 3000, // 3 windows
        });

        // The detected rate limit is calculated based on successful requests
        // With appropriate concurrency and rate limits, we should hit the limit
        // Allow ±50% variance since rate limit detection has inherent variance
        const ratio = result.rateLimit.requests / testCase.rateLimit;

        console.log(`[TEST] Rate limit accuracy ${testCase.rateLimit}:`, {
          detected: result.rateLimit.requests,
          designed: testCase.rateLimit,
          ratio: ratio.toFixed(2),
          windowMs: result.rateLimit.windowMs,
          confidence: result.confidence,
        });

        // Assert rate limit is within reasonable bounds
        // Detection may be lower due to how it averages across windows
        expect(result.rateLimit.requests).toBeGreaterThanOrEqual(1);
        expect(result.rateLimit.requests).toBeLessThanOrEqual(testCase.rateLimit * 2);

        // Window should be detected correctly (or use default 60000 if not hit)
        expect([testCase.windowMs, 60000]).toContain(result.rateLimit.windowMs);

        // Confidence should be medium or high
        expect(['medium', 'high']).toContain(result.confidence);
      }
    }, 30000);
  });
});
