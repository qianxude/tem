import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TEM } from '../../src/core/tem.js';
import { NonRetryableError } from '../../src/core/worker.js';
import { startMockServer, stopMockServer, createMockService } from '../../src/mock-server/index.js';
import type { MockResponse } from '../../src/mock-server/types.js';
import * as i from '../../src/interfaces/index.js';
import { waitForBatch } from '../../src/utils/index.js';
import type { BatchInterruptionCriteria } from '../../src/interfaces/index.js';

const TEST_PORT = 19997;
const MOCK_URL = `http://localhost:${TEST_PORT}`;

// Simulates OpenAI/Groq/Claude low-tier plan
const LLM_PROVIDER_CONFIG = {
  maxConcurrency: 2,        // Only 2 concurrent requests allowed
  rateLimit: { limit: 20, windowMs: 60000 },  // 20 req per 60s
  delayMs: [1000, 5000] as [number, number],  // 1-5s response time (realistic for LLM)
};

// Mid-tier provider config
const MID_TIER_CONFIG = {
  maxConcurrency: 5,
  rateLimit: { limit: 100, windowMs: 60000 },  // 100 req per 60s
  delayMs: [800, 3000] as [number, number],    // 0.8-3s response time
};

// LLM Task types
interface LLMTaskPayload {
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
}

interface LLMTaskResult {
  requestId: string;
  generated: string;
  tokensUsed: number;
  latencyMs: number;
}

// Metrics collector for test scenarios
interface TestMetrics {
  startTime: number;
  endTime: number;
  total429Errors: number;
  total503Errors: number;
  retryCount: number;
  successCount: number;
  failureCount: number;
}

describe('TEM with LLM Provider Simulation', () => {
  let tem: TEM;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    // Start mock server in multi mode
    startMockServer({ port: TEST_PORT, mode: 'multi' });

    // Create temp database
    tempDir = mkdtempSync(join(tmpdir(), 'tem-llm-simulation-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    // Stop TEM
    try {
      await tem.stop();
    } catch {
      // Ignore stop errors
    }

    // Stop mock server
    stopMockServer();

    // Wait for async operations
    await Bun.sleep(50);

    // Cleanup files
    try {
      unlinkSync(dbPath);
      rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Scenario 1: Unregulated TEM (Demonstrates the Problem)', () => {
    it('should experience many 429/503 errors when TEM limits exceed API limits', async () => {
      // Create low-tier LLM provider mock with shorter delays for test speed
      const res = await createMockService('low-tier-llm', {
        maxConcurrency: 2,
        rateLimit: { limit: 5, windowMs: 5000 },  // 5 per 5s window
        delayMs: [100, 300],  // Short delays for test speed
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // TEM configured with HIGHER limits than the API (the problem)
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 10,  // Higher than API limit of 2
        defaultMaxAttempts: 20,  // Higher to allow more retries
        pollIntervalMs: 10,
        // No rate limit - unregulated
      });

      const batch = await tem.batch.create({
        code: 'LLM-UNREGULATED-001',
        type: 'llm-unregulated-batch',
      });

      // Create 15 tasks - more than the rate limit allows
      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 15 }, (_, i) => ({
        batchId: batch.id,
        type: 'llm-request',
        payload: {
          provider: 'provider-a',
          model: 'gpt-4o-mini',
          prompt: `Generate text for task ${i}`,
          maxTokens: 150,
        } as LLMTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      const metrics: TestMetrics = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        retryCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      tem.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request',
        async (payload, context) => {
          // Add delay on retry to allow rate limit window to refill
          if (context.attempt > 1) {
            await Bun.sleep(1000);
            metrics.retryCount++;
          }

          // Use GET request (mock server only supports GET)
          const res = await fetch(`${MOCK_URL}/mock/low-tier-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metrics.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metrics.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          if (!res.ok) {
            metrics.failureCount++;
            throw new NonRetryableError(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = (await res.json()) as MockResponse;
          metrics.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: Math.floor(Math.random() * 100) + 50,
            latencyMs: data.meta.rt,
          };
        }
      );

      tem.worker.start();
      await waitForBatch(tem, batch.id, { timeoutMs: 120000 });
      metrics.endTime = Date.now();

      const finalStats = await tem.batch.getStats(batch.id);

      // Check for any failed tasks
      if (finalStats.failed > 0) {
        console.log(`  NOTE: ${finalStats.failed} tasks failed - demonstrating the unregulated problem`);
      }

      // All tasks should be accounted for
      expect(finalStats.total).toBe(15);
      expect(finalStats.completed + finalStats.failed).toBe(15);

      // Key demonstration: unregulated TEM should cause errors and potentially failures
      const totalErrors = metrics.total429Errors + metrics.total503Errors;
      expect(totalErrors).toBeGreaterThan(0);

      // In unregulated scenario, we may have some permanently failed tasks
      // This is the PROBLEM the test is demonstrating
      if (finalStats.failed > 0) {
        console.log(`  DEMONSTRATED: ${finalStats.failed} tasks permanently failed due to unregulated limits`);
      }

      console.log('[SCENARIO 1] Unregulated TEM Results:');
      console.log(`  Completion time: ${metrics.endTime - metrics.startTime}ms`);
      console.log(`  429 errors: ${metrics.total429Errors}`);
      console.log(`  503 errors: ${metrics.total503Errors}`);
      console.log(`  Total errors: ${totalErrors}`);
      console.log(`  Retries needed: ${metrics.retryCount}`);
      console.log(`  Failed tasks: ${finalStats.failed}`);
    }, 60000);
  });

  describe('Scenario 2: Self-Regulated TEM (The Solution)', () => {
    it('should have zero 429/503 errors when TEM limits match API limits', async () => {
      // Create low-tier LLM provider mock
      const res = await createMockService('regulated-llm', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 5000 },  // 10 per 5s
        delayMs: [100, 300],
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // TEM configured to MATCH the API limits (the solution)
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,  // Matches API limit exactly
        rateLimit: { requests: 10, windowMs: 5000 },  // Matches API limit
        defaultMaxAttempts: 5,
        pollIntervalMs: 10,
      });

      const batch = await tem.batch.create({
        code: 'LLM-REGULATED-001',
        type: 'llm-regulated-batch',
      });

      // Create 10 tasks - at the rate limit
      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'llm-request',
        payload: {
          provider: 'provider-a',
          model: 'gpt-4o-mini',
          prompt: `Generate text for task ${i}`,
          maxTokens: 150,
        } as LLMTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      const metrics: TestMetrics = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        retryCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      tem.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request',
        async (payload) => {
          // No backoff needed - TEM limits prevent errors
          const res = await fetch(`${MOCK_URL}/mock/regulated-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metrics.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metrics.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          if (!res.ok) {
            throw new NonRetryableError(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = (await res.json()) as MockResponse;
          metrics.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: Math.floor(Math.random() * 100) + 50,
            latencyMs: data.meta.rt,
          };
        }
      );

      tem.worker.start();
      await waitForBatch(tem, batch.id, { timeoutMs: 60000 });
      metrics.endTime = Date.now();

      const finalStats = await tem.batch.getStats(batch.id);

      // All tasks should complete
      expect(finalStats.total).toBe(10);
      expect(finalStats.completed).toBe(10);
      expect(finalStats.failed).toBe(0);

      // With proper regulation, we should have ZERO 429/503 errors
      expect(metrics.total429Errors).toBe(0);
      expect(metrics.total503Errors).toBe(0);

      console.log('[SCENARIO 2] Self-Regulated TEM Results:');
      console.log(`  Completion time: ${metrics.endTime - metrics.startTime}ms`);
      console.log(`  429 errors: ${metrics.total429Errors}`);
      console.log(`  503 errors: ${metrics.total503Errors}`);
      console.log(`  Failed tasks: ${finalStats.failed}`);
      console.log('  SUCCESS: Zero errors with proper self-regulation!');
    }, 60000);
  });

  describe('Scenario 3: Burst Handling with Retry Backoff', () => {
    it('should handle burst loads with exponential backoff on limit violations', async () => {
      // Create low-tier provider with stricter limits
      const res = await createMockService('burst-llm', {
        maxConcurrency: 2,
        rateLimit: { limit: 5, windowMs: 5000 },  // 5 per 5s
        delayMs: [100, 200],
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // TEM configured properly but tasks created in burst
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        rateLimit: { requests: 5, windowMs: 5000 },
        defaultMaxAttempts: 10,
        pollIntervalMs: 10,
      });

      const batch = await tem.batch.create({
        code: 'LLM-BURST-001',
        type: 'llm-burst-batch',
      });

      // Create 12 tasks in a burst - more than rate limit allows
      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 12 }, (_, i) => ({
        batchId: batch.id,
        type: 'llm-request',
        maxAttempt: 10,
        payload: {
          provider: 'provider-a',
          model: 'gpt-4o-mini',
          prompt: `Burst task ${i}`,
          maxTokens: 100,
        } as LLMTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      const metrics: TestMetrics = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        retryCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      tem.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request',
        async (payload, context) => {
          // Exponential backoff on retry
          if (context.attempt > 1) {
            const backoffMs = Math.min(1000 * Math.pow(2, context.attempt - 1), 10000);
            await Bun.sleep(backoffMs);
            metrics.retryCount++;
          }

          const res = await fetch(`${MOCK_URL}/mock/burst-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metrics.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metrics.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          if (!res.ok) {
            throw new NonRetryableError(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = (await res.json()) as MockResponse;
          metrics.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: Math.floor(Math.random() * 100) + 50,
            latencyMs: data.meta.rt,
          };
        }
      );

      tem.worker.start();
      await waitForBatch(tem, batch.id, { timeoutMs: 120000 });
      metrics.endTime = Date.now();

      const finalStats = await tem.batch.getStats(batch.id);

      // All tasks should eventually complete with backoff
      expect(finalStats.total).toBe(12);
      expect(finalStats.completed).toBe(12);
      expect(finalStats.failed).toBe(0);

      console.log('[SCENARIO 3] Burst Handling with Backoff Results:');
      console.log(`  Completion time: ${metrics.endTime - metrics.startTime}ms`);
      console.log(`  429 errors: ${metrics.total429Errors}`);
      console.log(`  503 errors: ${metrics.total503Errors}`);
      console.log(`  Retries with backoff: ${metrics.retryCount}`);
      console.log(`  Failed tasks: ${finalStats.failed}`);
    }, 120000);
  });

  describe('Scenario 4: Large Batch Processing (100+ tasks)', () => {
    it('should process 50+ tasks with realistic LLM delays efficiently', async () => {
      // Create provider with realistic LLM constraints (scaled for test)
      const res = await createMockService('large-batch-llm', {
        maxConcurrency: 3,
        rateLimit: { limit: 20, windowMs: 10000 },  // 20 per 10s
        delayMs: [50, 150],  // Short delays for test
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // Self-regulated TEM
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 3,
        rateLimit: { requests: 20, windowMs: 10000 },
        defaultMaxAttempts: 5,
        pollIntervalMs: 10,
      });

      const batch = await tem.batch.create({
        code: 'LLM-LARGE-001',
        type: 'llm-large-batch',
      });

      const taskCount = 50;

      // Create 50 tasks
      const chunkSize = 25;
      for (let i = 0; i < taskCount; i += chunkSize) {
        const chunk: i.CreateTaskInput[] = Array.from(
          { length: Math.min(chunkSize, taskCount - i) },
          (_, j) => ({
            batchId: batch.id,
            type: 'llm-request',
            payload: {
              provider: 'provider-a',
              model: 'gpt-4o-mini',
              prompt: `Generate summary for document ${i + j}`,
              maxTokens: 200,
            } as LLMTaskPayload,
          })
        );
        await tem.task.createMany(chunk);
      }

      const metrics: TestMetrics = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        retryCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      tem.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request',
        async () => {
          const res = await fetch(`${MOCK_URL}/mock/large-batch-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metrics.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metrics.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          if (!res.ok) {
            throw new NonRetryableError(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = (await res.json()) as MockResponse;
          metrics.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: Math.floor(Math.random() * 150) + 50,
            latencyMs: data.meta.rt,
          };
        }
      );

      tem.worker.start();
      await waitForBatch(tem, batch.id, { timeoutMs: 120000 });
      metrics.endTime = Date.now();

      const finalStats = await tem.batch.getStats(batch.id);

      // All 50 tasks should complete successfully
      expect(finalStats.total).toBe(taskCount);
      expect(finalStats.completed).toBe(taskCount);
      expect(finalStats.pending).toBe(0);
      expect(finalStats.running).toBe(0);
      expect(finalStats.failed).toBe(0);

      // With self-regulation, should have minimal or zero errors
      const totalErrors = metrics.total429Errors + metrics.total503Errors;

      const totalTime = metrics.endTime - metrics.startTime;
      const throughput = (taskCount / totalTime) * 60000; // tasks per minute

      console.log('[SCENARIO 4] Large Batch Processing Results:');
      console.log(`  Total tasks: ${taskCount}`);
      console.log(`  Completion time: ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
      console.log(`  429 errors: ${metrics.total429Errors}`);
      console.log(`  503 errors: ${metrics.total503Errors}`);
      console.log(`  Total errors: ${totalErrors}`);
      console.log(`  Failed tasks: ${finalStats.failed}`);
      console.log(`  Effective throughput: ${throughput.toFixed(1)} tasks/minute`);
    }, 120000);
  });

  describe('Scenario 5: Multiple LLM Providers (Different Constraints)', () => {
    it('should handle tasks across providers with different rate limits', async () => {
      // Provider A: Low-tier (2 concurrency, 10/5s)
      const res1 = await createMockService('provider-a-llm', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 5000 },
        delayMs: [50, 100],
      }, MOCK_URL);
      expect(res1.status).toBe(201);

      // Provider B: Mid-tier (5 concurrency, 20/5s)
      const res2 = await createMockService('provider-b-llm', {
        maxConcurrency: 5,
        rateLimit: { limit: 20, windowMs: 5000 },
        delayMs: [30, 80],
      }, MOCK_URL);
      expect(res2.status).toBe(201);

      // Create temp directories for both databases
      const dbPathA = join(tempDir, 'test-a.db');
      const dbPathB = join(tempDir, 'test-b.db');

      // Provider A TEM - strict limits
      const temA = new TEM({
        databasePath: dbPathA,
        concurrency: 2,
        rateLimit: { requests: 10, windowMs: 5000 },
        defaultMaxAttempts: 5,
        pollIntervalMs: 10,
      });

      // Provider B TEM - relaxed limits
      const temB = new TEM({
        databasePath: dbPathB,
        concurrency: 5,
        rateLimit: { requests: 20, windowMs: 5000 },
        defaultMaxAttempts: 5,
        pollIntervalMs: 10,
      });

      // Use the main tem reference for cleanup of A (B will be stopped manually)
      tem = temA;

      const batchA = await temA.batch.create({
        code: 'LLM-MULTI-A-001',
        type: 'llm-provider-a-batch',
      });

      const batchB = await temB.batch.create({
        code: 'LLM-MULTI-B-001',
        type: 'llm-provider-b-batch',
      });

      // Create tasks for provider A (low-tier, fewer tasks)
      const tasksA: i.CreateTaskInput[] = Array.from({ length: 8 }, (_, i) => ({
        batchId: batchA.id,
        type: 'llm-request-a',
        payload: {
          provider: 'provider-a',
          model: 'gpt-4o-mini',
          prompt: `Low-tier task ${i}`,
        } as LLMTaskPayload,
      }));

      // Create tasks for provider B (mid-tier, more tasks)
      const tasksB: i.CreateTaskInput[] = Array.from({ length: 15 }, (_, i) => ({
        batchId: batchB.id,
        type: 'llm-request-b',
        payload: {
          provider: 'provider-b',
          model: 'gpt-4o',
          prompt: `Mid-tier task ${i}`,
        } as LLMTaskPayload,
      }));

      await temA.task.createMany(tasksA);
      await temB.task.createMany(tasksB);

      const metricsA = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        successCount: 0,
      };

      const metricsB = {
        startTime: Date.now(),
        endTime: 0,
        total429Errors: 0,
        total503Errors: 0,
        successCount: 0,
      };

      // Register handlers for each provider
      temA.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request-a',
        async () => {
          const res = await fetch(`${MOCK_URL}/mock/provider-a-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metricsA.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metricsA.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          const data = (await res.json()) as MockResponse;
          metricsA.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: 100,
            latencyMs: data.meta.rt,
          };
        }
      );

      temB.worker.register<LLMTaskPayload, LLMTaskResult>(
        'llm-request-b',
        async () => {
          const res = await fetch(`${MOCK_URL}/mock/provider-b-llm`, {
            method: 'GET',
          });

          if (res.status === 429) {
            metricsB.total429Errors++;
            throw new Error('rate_limit_exceeded');
          }

          if (res.status === 503) {
            metricsB.total503Errors++;
            throw new Error('concurrency_limit_exceeded');
          }

          const data = (await res.json()) as MockResponse;
          metricsB.successCount++;
          return {
            requestId: data.requestId,
            generated: data.data,
            tokensUsed: 150,
            latencyMs: data.meta.rt,
          };
        }
      );

      // Start both workers
      const startTime = Date.now();
      temA.worker.start();
      temB.worker.start();

      // Wait for both batches to complete
      await Promise.all([
        waitForBatch(temA, batchA.id, { timeoutMs: 60000 }),
        waitForBatch(temB, batchB.id, { timeoutMs: 60000 }),
      ]);

      const totalTime = Date.now() - startTime;
      metricsA.endTime = Date.now();
      metricsB.endTime = Date.now();

      // Stop both TEMs before getting stats
      await temA.stop();
      await temB.stop();

      console.log('[SCENARIO 5] Multiple Provider Results:');
      console.log(`  Provider A (low-tier): ${metricsA.successCount} tasks, ${metricsA.total429Errors + metricsA.total503Errors} errors`);
      console.log(`  Provider B (mid-tier): ${metricsB.successCount} tasks, ${metricsB.total429Errors + metricsB.total503Errors} errors`);
      console.log(`  Total time: ${totalTime}ms`);

      // Verify all tasks completed
      expect(metricsA.successCount).toBe(8);
      expect(metricsB.successCount).toBe(15);

      // Both should have zero errors due to self-regulation
      expect(metricsA.total429Errors).toBe(0);
      expect(metricsA.total503Errors).toBe(0);
      expect(metricsB.total429Errors).toBe(0);
      expect(metricsB.total503Errors).toBe(0);

      console.log('  SUCCESS: Multi-tenant limit management works!');
    }, 120000);
  });

  describe('Performance Comparison Summary', () => {
    it('should demonstrate the performance difference between regulated and unregulated', async () => {
      // Create two identical services
      const res1 = await createMockService('compare-unregulated', {
        maxConcurrency: 2,
        rateLimit: { limit: 8, windowMs: 5000 },
        delayMs: [50, 100],
      }, MOCK_URL);
      expect(res1.status).toBe(201);

      const res2 = await createMockService('compare-regulated', {
        maxConcurrency: 2,
        rateLimit: { limit: 8, windowMs: 5000 },
        delayMs: [50, 100],
      }, MOCK_URL);
      expect(res2.status).toBe(201);

      const dbPathUnregulated = join(tempDir, 'unregulated.db');
      const dbPathRegulated = join(tempDir, 'regulated.db');

      // Test 1: Unregulated TEM
      const temUnregulated = new TEM({
        databasePath: dbPathUnregulated,
        concurrency: 8,  // Too high
        defaultMaxAttempts: 10,
        pollIntervalMs: 10,
      });

      const batchUnregulated = await temUnregulated.batch.create({
        code: 'COMPARE-UNREGULATED',
        type: 'comparison-batch',
      });

      await temUnregulated.task.createMany(
        Array.from({ length: 12 }, (_, i) => ({
          batchId: batchUnregulated.id,
          type: 'compare-task',
          payload: { index: i },
        }))
      );

      let unregulatedErrors = 0;

      temUnregulated.worker.register<{ index: number }, { success: boolean }>(
        'compare-task',
        async (payload, context) => {
          if (context.attempt > 1) {
            await Bun.sleep(500);
          }

          const res = await fetch(`${MOCK_URL}/mock/compare-unregulated`, {
            method: 'GET',
          });

          if (res.status === 429 || res.status === 503) {
            unregulatedErrors++;
            throw new Error('limit_exceeded');
          }

          return { success: true };
        }
      );

      const startUnregulated = Date.now();
      temUnregulated.worker.start();
      await waitForBatch(temUnregulated, batchUnregulated.id, { timeoutMs: 60000 });
      const timeUnregulated = Date.now() - startUnregulated;

      await temUnregulated.stop();

      // Test 2: Regulated TEM
      const temRegulated = new TEM({
        databasePath: dbPathRegulated,
        concurrency: 2,  // Matches API
        rateLimit: { requests: 8, windowMs: 5000 },
        defaultMaxAttempts: 5,
        pollIntervalMs: 10,
      });

      const batchRegulated = await temRegulated.batch.create({
        code: 'COMPARE-REGULATED',
        type: 'comparison-batch',
      });

      await temRegulated.task.createMany(
        Array.from({ length: 12 }, (_, i) => ({
          batchId: batchRegulated.id,
          type: 'compare-task',
          payload: { index: i },
        }))
      );

      let regulatedErrors = 0;

      temRegulated.worker.register<{ index: number }, { success: boolean }>(
        'compare-task',
        async () => {
          const res = await fetch(`${MOCK_URL}/mock/compare-regulated`, {
            method: 'GET',
          });

          if (res.status === 429 || res.status === 503) {
            regulatedErrors++;
            throw new Error('limit_exceeded');
          }

          return { success: true };
        }
      );

      const startRegulated = Date.now();
      temRegulated.worker.start();
      await waitForBatch(temRegulated, batchRegulated.id, { timeoutMs: 60000 });
      const timeRegulated = Date.now() - startRegulated;

      await temRegulated.stop();

      // Summary
      console.log('\n[PERFORMANCE COMPARISON SUMMARY]');
      console.log('================================');
      console.log('Configuration        | Unregulated | Self-Regulated');
      console.log('---------------------|-------------|---------------');
      console.log(`Concurrency          | 8           | 2`);
      console.log(`Rate Limit           | None        | 8/5s`);
      console.log(`---------------------|-------------|---------------`);
      console.log(`Completion Time      | ${timeUnregulated}ms     | ${timeRegulated}ms`);
      console.log(`Errors (429/503)     | ${unregulatedErrors}          | ${regulatedErrors}`);
      console.log(`---------------------|-------------|---------------`);

      // Verify regulated has fewer errors
      expect(regulatedErrors).toBeLessThanOrEqual(unregulatedErrors);

      if (regulatedErrors === 0 && unregulatedErrors > 0) {
        console.log('✓ CONCLUSION: Self-regulation eliminates errors!');
      } else if (regulatedErrors === 0 && unregulatedErrors === 0) {
        console.log('✓ CONCLUSION: Both completed successfully (API limits were not exceeded)');
      }
      console.log('================================');
    }, 120000);
  });

  describe('LLM Provider Interruption', () => {
    describe('Error Rate Interruption with LLM Provider', () => {
      it('should interrupt batch when LLM provider has high failure rate', async () => {
        // Create mock LLM provider with high failure rate (simulating provider issues)
        const res = await createMockService('unstable-llm-provider', {
          maxConcurrency: 5,
          rateLimit: { limit: 50, windowMs: 10000 },
          delayMs: [50, 100],
          errorSimulation: {
            rate: 0.6, // 60% error rate - simulating unstable provider
            statusCode: 500,
            errorMessage: 'llm_provider_error',
          },
        }, MOCK_URL);
        expect(res.status).toBe(201);

        tem = new TEM({
          databasePath: dbPath,
          concurrency: 5,
          defaultMaxAttempts: 2,
          pollIntervalMs: 10,
        });

        const criteria: BatchInterruptionCriteria = {
          maxErrorRate: 0.2, // 20% error rate threshold - strict to catch issues early
        };

        const batch = await tem.batch.create({
          code: 'LLM-ERROR-RATE-001',
          type: 'llm-error-rate-batch',
          interruptionCriteria: criteria,
        });

        // Create LLM tasks
        const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
          batchId: batch.id,
          type: 'llm-request',
          payload: {
            provider: 'unstable-provider',
            model: 'gpt-4o',
            prompt: `Generate text for task ${i}`,
            maxTokens: 150,
          } as LLMTaskPayload,
        }));

        await tem.task.createMany(taskInputs);

        tem.worker.register<LLMTaskPayload, LLMTaskResult>(
          'llm-request',
          async () => {
            const res = await fetch(`${MOCK_URL}/mock/unstable-llm-provider`, {
              method: 'GET',
            });

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as MockResponse;
            return {
              requestId: data.requestId,
              generated: data.data,
              tokensUsed: Math.floor(Math.random() * 100) + 50,
              latencyMs: data.meta.rt,
            };
          }
        );

        tem.worker.start();

        // Wait for interruption
        const startTime = Date.now();
        let batchStatus = await tem.batch.getById(batch.id);
        while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 15000) {
          await Bun.sleep(100);
          batchStatus = await tem.batch.getById(batch.id);
        }

        // Verify batch was interrupted due to error rate
        expect(batchStatus?.status).toBe('interrupted');

        // Verify interruption log
        const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
        expect(interruptionLog.length).toBeGreaterThan(0);
        expect(interruptionLog[0]?.reason).toBe('error_rate_exceeded');

        console.log('[LLM Provider Interruption] Error rate exceeded test passed');
        console.log(`  Interruption reason: ${interruptionLog[0]?.reason}`);
        console.log(`  Message: ${interruptionLog[0]?.message}`);
      }, 20000);
    });

    describe('Rate Limit Interruption', () => {
      it('should interrupt batch when aggressively rate limited by provider', async () => {
        // Create mock LLM provider with aggressive rate limiting
        const res = await createMockService('rate-limited-llm-provider', {
          maxConcurrency: 10,
          rateLimit: { limit: 2, windowMs: 10000 }, // Very strict: 2 requests per 10 seconds
          delayMs: [50, 100],
        }, MOCK_URL);
        expect(res.status).toBe(201);

        tem = new TEM({
          databasePath: dbPath,
          concurrency: 8, // Much higher than provider allows
          defaultMaxAttempts: 3,
          pollIntervalMs: 10,
        });

        const criteria: BatchInterruptionCriteria = {
          maxRateLimitHits: 10,
        };

        const batch = await tem.batch.create({
          code: 'LLM-RATE-LIMIT-001',
          type: 'llm-rate-limit-batch',
          interruptionCriteria: criteria,
        });

        // Create many tasks to trigger rate limits
        const taskInputs: i.CreateTaskInput[] = Array.from({ length: 20 }, (_, i) => ({
          batchId: batch.id,
          type: 'llm-request',
          payload: {
            provider: 'rate-limited-provider',
            model: 'claude-3-haiku',
            prompt: `Process task ${i}`,
            maxTokens: 100,
          } as LLMTaskPayload,
        }));

        await tem.task.createMany(taskInputs);

        let rateLimitHits = 0;

        tem.worker.register<LLMTaskPayload, LLMTaskResult>(
          'llm-request',
          async (payload, context) => {
            const res = await fetch(`${MOCK_URL}/mock/rate-limited-llm-provider`, {
              method: 'GET',
            });

            if (res.status === 429) {
              rateLimitHits++;
              throw new Error('rate_limit_exceeded');
            }

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as MockResponse;
            return {
              requestId: data.requestId,
              generated: data.data,
              tokensUsed: Math.floor(Math.random() * 50) + 25,
              latencyMs: data.meta.rt,
            };
          }
        );

        tem.worker.start();

        // Wait for interruption
        const startTime = Date.now();
        let batchStatus = await tem.batch.getById(batch.id);
        while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 20000) {
          await Bun.sleep(100);
          batchStatus = await tem.batch.getById(batch.id);
        }

        // Verify batch was interrupted
        expect(batchStatus?.status).toBe('interrupted');

        // Verify interruption log
        const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
        expect(interruptionLog.length).toBeGreaterThan(0);
        expect(interruptionLog[0]?.reason).toBe('rate_limit_hits_exceeded');

        console.log('[LLM Provider Interruption] Rate limit exceeded test passed');
        console.log(`  Total rate limit hits: ${rateLimitHits}`);
        console.log(`  Interruption message: ${interruptionLog[0]?.message}`);
      }, 30000);
    });

    describe('Multiple Providers with Different Criteria', () => {
      it('should handle two batches with different interruption criteria', async () => {
        // Provider A: Strict limits
        const res1 = await createMockService('strict-llm-provider', {
          maxConcurrency: 2,
          rateLimit: { limit: 5, windowMs: 5000 },
          delayMs: [30, 60],
          errorSimulation: {
            rate: 0.3, // 30% error rate
            statusCode: 500,
            errorMessage: 'provider_a_error',
          },
        }, MOCK_URL);
        expect(res1.status).toBe(201);

        // Provider B: More lenient
        const res2 = await createMockService('lenient-llm-provider', {
          maxConcurrency: 5,
          rateLimit: { limit: 20, windowMs: 5000 },
          delayMs: [20, 40],
        }, MOCK_URL);
        expect(res2.status).toBe(201);

        // Create temp directories for both databases
        const dbPathStrict = join(tempDir, 'test-strict.db');
        const dbPathLenient = join(tempDir, 'test-lenient.db');

        // Provider A TEM - strict interruption criteria
        const temStrict = new TEM({
          databasePath: dbPathStrict,
          concurrency: 3,
          defaultMaxAttempts: 2,
          pollIntervalMs: 10,
        });

        // Provider B TEM - lenient interruption criteria
        const temLenient = new TEM({
          databasePath: dbPathLenient,
          concurrency: 5,
          defaultMaxAttempts: 3,
          pollIntervalMs: 10,
        });

        // Use the main tem reference for cleanup
        tem = temStrict;

        // Batch A: Strict criteria (interrupts early)
        const strictCriteria: BatchInterruptionCriteria = {
          maxErrorRate: 0.25, // 25% threshold - will trigger with 30% error rate
          maxConsecutiveFailures: 2,
        };

        const batchStrict = await temStrict.batch.create({
          code: 'LLM-MULTI-STRICT-001',
          type: 'llm-strict-batch',
          interruptionCriteria: strictCriteria,
        });

        // Batch B: Lenient criteria (allows more errors)
        const lenientCriteria: BatchInterruptionCriteria = {
          maxErrorRate: 0.5, // 50% threshold - won't trigger
          maxFailedTasks: 20, // High threshold
        };

        const batchLenient = await temLenient.batch.create({
          code: 'LLM-MULTI-LENIENT-001',
          type: 'llm-lenient-batch',
          interruptionCriteria: lenientCriteria,
        });

        // Create tasks for both batches
        const tasksStrict: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
          batchId: batchStrict.id,
          type: 'llm-request-strict',
          payload: {
            provider: 'strict-provider',
            model: 'gpt-4o-mini',
            prompt: `Strict batch task ${i}`,
            maxTokens: 100,
          } as LLMTaskPayload,
        }));

        const tasksLenient: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
          batchId: batchLenient.id,
          type: 'llm-request-lenient',
          payload: {
            provider: 'lenient-provider',
            model: 'gpt-4o',
            prompt: `Lenient batch task ${i}`,
            maxTokens: 100,
          } as LLMTaskPayload,
        }));

        await temStrict.task.createMany(tasksStrict);
        await temLenient.task.createMany(tasksLenient);

        // Register handlers
        temStrict.worker.register<LLMTaskPayload, LLMTaskResult>(
          'llm-request-strict',
          async () => {
            const res = await fetch(`${MOCK_URL}/mock/strict-llm-provider`, {
              method: 'GET',
            });

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as MockResponse;
            return {
              requestId: data.requestId,
              generated: data.data,
              tokensUsed: 100,
              latencyMs: data.meta.rt,
            };
          }
        );

        temLenient.worker.register<LLMTaskPayload, LLMTaskResult>(
          'llm-request-lenient',
          async () => {
            const res = await fetch(`${MOCK_URL}/mock/lenient-llm-provider`, {
              method: 'GET',
            });

            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = (await res.json()) as MockResponse;
            return {
              requestId: data.requestId,
              generated: data.data,
              tokensUsed: 100,
              latencyMs: data.meta.rt,
            };
          }
        );

        // Start both workers
        temStrict.worker.start();
        temLenient.worker.start();

        // Wait for strict batch to be interrupted
        const startTime = Date.now();
        let strictStatus = await temStrict.batch.getById(batchStrict.id);
        while (strictStatus?.status !== 'interrupted' && Date.now() - startTime < 15000) {
          await Bun.sleep(100);
          strictStatus = await temStrict.batch.getById(batchStrict.id);
        }

        // Strict batch should be interrupted
        expect(strictStatus?.status).toBe('interrupted');

        // Wait for lenient batch to complete
        await waitForBatch(temLenient, batchLenient.id, { timeoutMs: 30000 });

        // Lenient batch should complete successfully
        const lenientStats = await temLenient.batch.getStats(batchLenient.id);
        expect(lenientStats.completed).toBe(10);
        expect(lenientStats.failed).toBe(0);

        // Stop both TEMs
        await temStrict.stop();
        await temLenient.stop();

        // Verify interruption log for strict batch
        const strictInterruptionLog = await temStrict.interruption.getInterruptionLog(batchStrict.id);
        expect(strictInterruptionLog.length).toBeGreaterThan(0);

        console.log('[Multiple Providers] Test passed');
        console.log(`  Strict batch status: ${strictStatus?.status}`);
        console.log(`  Strict batch interruption: ${strictInterruptionLog[0]?.reason}`);
        console.log(`  Lenient batch completed: ${lenientStats.completed}/${lenientStats.total}`);
      }, 45000);
    });
  });
});
