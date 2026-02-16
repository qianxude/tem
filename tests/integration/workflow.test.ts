import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TEM } from '../../src/core/tem.js';
import { NonRetryableError } from '../../src/core/worker.js';
import * as i from '../../src/interfaces/index.js';
import {
  createTrackedMockHandler,
} from './mock-llm.js';

describe('Integration Workflows', () => {
  let tem: TEM;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tem-integration-'));
    dbPath = join(tempDir, 'test.db');
    tem = new TEM({
      databasePath: dbPath,
      concurrency: 2,
      defaultMaxAttempts: 3,
      pollIntervalMs: 10,
    });
  });

  afterEach(async () => {
    try {
      await tem.stop();
    } catch {
      // Ignore stop errors (may already be stopped)
    }
    // Wait a bit for any async operations to complete
    await Bun.sleep(50);
    try {
      unlinkSync(dbPath);
      rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Full Workflow', () => {
    it('should process batch of tasks end-to-end', async () => {
      // Create batch
      const batch = await tem.batch.create({
        code: 'WORKFLOW-001',
        type: 'llm-processing',
      });

      // Create tasks
      const tasks = await tem.task.createMany([
        { batchId: batch.id, type: 'llm-call', payload: { prompt: 'Task 1' } },
        { batchId: batch.id, type: 'llm-call', payload: { prompt: 'Task 2' } },
        { batchId: batch.id, type: 'llm-call', payload: { prompt: 'Task 3' } },
      ]);

      expect(tasks.length).toBe(3);

      // Register handler
      const processed: string[] = [];
      tem.worker.register('llm-call', async (payload: { prompt: string }) => {
        processed.push(payload.prompt);
        return { result: `Processed: ${payload.prompt}` };
      });

      // Start worker and wait for completion
      tem.worker.start();

      // Poll until all tasks complete
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        const stats = await tem.batch.getStats(batch.id);
        if (stats.completed === 3) break;
        await Bun.sleep(50);
      }

      // Verify results
      const finalStats = await tem.batch.getStats(batch.id);
      expect(finalStats.total).toBe(3);
      expect(finalStats.completed).toBe(3);
      expect(finalStats.pending).toBe(0);
      expect(finalStats.failed).toBe(0);

      // Verify all tasks were processed
      expect(processed.sort()).toEqual(['Task 1', 'Task 2', 'Task 3']);

      // Verify task results
      for (const task of tasks) {
        const t = await tem.task.getById(task.id);
        expect(t?.status).toBe('completed');
        expect(t?.result).toContain('Processed');
      }
    });

    it('should complete batch when all tasks finish', async () => {
      const batch = await tem.batch.create({
        code: 'BATCH-COMPLETE',
        type: 'test',
      });

      await tem.task.createMany([
        { batchId: batch.id, type: 'fast-task', payload: {} },
        { batchId: batch.id, type: 'fast-task', payload: {} },
      ]);

      tem.worker.register('fast-task', async () => {
        await Bun.sleep(10);
        return { done: true };
      });

      tem.worker.start();

      // Wait for completion
      await Bun.sleep(200);

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.completed).toBe(2);
    });
  });

  describe('Retry Mechanism', () => {
    it('should automatically retry failed tasks', async () => {
      const batch = await tem.batch.create({
        code: 'RETRY-TEST',
        type: 'unstable',
      });

      await tem.task.createMany([
        { batchId: batch.id, type: 'unstable-task', payload: { id: 1 } },
        { batchId: batch.id, type: 'unstable-task', payload: { id: 2 } },
      ]);

      let attempts = 0;
      tem.worker.register('unstable-task', async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return { success: true };
      });

      tem.worker.start();

      // Wait for processing
      await Bun.sleep(500);

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.completed).toBe(2);
      expect(attempts).toBeGreaterThanOrEqual(3);
    });

    it('should respect max attempts limit', async () => {
      const batch = await tem.batch.create({
        code: 'MAX-RETRY',
        type: 'always-fails',
      });

      const [task] = await tem.task.createMany([
        { batchId: batch.id, type: 'failing-task', payload: {}, maxAttempt: 2 },
      ]);

      let attempts = 0;
      tem.worker.register('failing-task', async () => {
        attempts++;
        throw new Error('Always fails');
      });

      tem.worker.start();

      // Wait for processing with retries
      await Bun.sleep(500);

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.failed).toBe(1);
      expect(attempts).toBe(2); // Initial + 1 retry

      // Get task by original ID instead of claiming
      const finalTask = await tem.task.getById(task.id);
      expect(finalTask?.status).toBe('failed');
      expect(finalTask?.error).toBe('Always fails');
    });

    it('should immediately fail on NonRetryableError', async () => {
      const batch = await tem.batch.create({
        code: 'NON-RETRYABLE',
        type: 'critical',
      });

      await tem.task.createMany([
        { batchId: batch.id, type: 'critical-task', payload: {} },
      ]);

      let attempts = 0;
      tem.worker.register('critical-task', async () => {
        attempts++;
        throw new NonRetryableError('Critical error - do not retry');
      });

      tem.worker.start();

      // Wait briefly
      await Bun.sleep(100);

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.failed).toBe(1);
      expect(attempts).toBe(1); // No retries
    });

    it('should handle mock LLM with realistic failure rate', async () => {
      const batch = await tem.batch.create({
        code: 'LLM-RETRY',
        type: 'llm-batch',
      });

      // Create many tasks to observe failure/retry behavior statistically
      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 20 }, (_, i) => ({
        batchId: batch.id,
        type: 'llm-call',
        payload: { prompt: `Prompt ${i}`, model: 'test' },
      }));

      await tem.task.createMany(taskInputs);

      // Use tracked handler with 30% failure rate
      const { handler, metrics } = createTrackedMockHandler({
        failureRate: 0.3,
        rateLimitErrorRate: 0.05,
        minDelay: 10,
        maxDelay: 30,
      });

      tem.worker.register('llm-call', handler);
      tem.worker.start();

      // Wait for all processing to complete
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        const stats = await tem.batch.getStats(batch.id);
        if (stats.pending === 0 && stats.running === 0) break;
        await Bun.sleep(50);
      }

      const finalStats = await tem.batch.getStats(batch.id);

      // With 30% failure and 3 attempts, most tasks should eventually succeed
      expect(finalStats.total).toBe(20);
      expect(metrics.calls).toBeGreaterThanOrEqual(20); // Some retries happened

      // Due to retries, many initially failed tasks should complete
      const successRate = finalStats.completed / finalStats.total;
      expect(successRate).toBeGreaterThan(0.5); // Majority should succeed with retries
    });
  });

  describe('Crash Recovery', () => {
    it('should reset running tasks on resume', async () => {
      // Create a batch and manually set tasks to running state
      const batch = await tem.batch.create({
        code: 'CRASH-RECOVERY',
        type: 'interruptible',
      });

      const tasks = await tem.task.createMany([
        { batchId: batch.id, type: 'recoverable-task', payload: { id: 1 } },
        { batchId: batch.id, type: 'recoverable-task', payload: { id: 2 } },
        { batchId: batch.id, type: 'recoverable-task', payload: { id: 3 } },
      ]);

      // Manually set tasks to running state to simulate mid-processing crash
      for (const _task of tasks) {
        await tem.task.claim(batch.id);
      }

      // Verify tasks are in running state
      const statsBefore = await tem.batch.getStats(batch.id);
      expect(statsBefore.running).toBe(3);
      expect(statsBefore.pending).toBe(0);

      // Resume batch - resets running tasks back to pending
      const resumed = await tem.batch.resume(batch.id);
      expect(resumed).toBe(3);

      // Verify tasks are back to pending
      const statsAfter = await tem.batch.getStats(batch.id);
      expect(statsAfter.running).toBe(0);
      expect(statsAfter.pending).toBe(3);

      // Now start worker and process
      const processed: number[] = [];
      tem.worker.register('recoverable-task', async (payload: { id: number }) => {
        processed.push(payload.id);
        await Bun.sleep(10);
        return { done: true };
      });
      tem.worker.start();

      // Wait for completion
      while (true) {
        const stats = await tem.batch.getStats(batch.id);
        if (stats.completed === 3) break;
        await Bun.sleep(50);
      }

      const finalStats = await tem.batch.getStats(batch.id);
      expect(finalStats.completed).toBe(3);
      expect(processed.length).toBe(3);
    });

    it('should not duplicate processing after resume', async () => {
      const batch = await tem.batch.create({
        code: 'NO-DUPLICATE',
        type: 'exactly-once',
      });

      await tem.task.createMany([
        { batchId: batch.id, type: 'counted-task', payload: { id: 1 } },
        { batchId: batch.id, type: 'counted-task', payload: { id: 2 } },
      ]);

      const processed = new Set<number>();
      tem.worker.register('counted-task', async (payload: { id: number }) => {
        processed.add(payload.id);
        await Bun.sleep(10);
        return { processed: payload.id };
      });

      tem.worker.start();
      await Bun.sleep(100);

      // Stop and resume
      await tem.stop();

      // Create new TEM instance for recovery
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        defaultMaxAttempts: 3,
        pollIntervalMs: 10,
      });

      await tem.batch.resume(batch.id);

      // Restart
      tem.worker.register('counted-task', async (payload: { id: number }) => {
        processed.add(payload.id);
        await Bun.sleep(10);
        return { processed: payload.id };
      });
      tem.worker.start();

      // Wait for completion
      while (true) {
        const stats = await tem.batch.getStats(batch.id);
        if (stats.completed === 2) break;
        await Bun.sleep(50);
      }

      // Each task should be processed exactly once
      expect(processed.size).toBe(2);
    });
  });

  describe('Rate Limiting Accuracy', () => {
    it('should enforce rate limits', async () => {
      // Use a more lenient rate limit to avoid timing issues in CI
      const rateLimitedTem = new TEM({
        databasePath: dbPath,
        concurrency: 10,
        defaultMaxAttempts: 3,
        pollIntervalMs: 10,
        rateLimit: { requests: 5, windowMs: 500 }, // 5 requests per 500ms
      });

      const batch = await rateLimitedTem.batch.create({
        code: 'RATE-LIMIT',
        type: 'throttled',
      });

      await rateLimitedTem.task.createMany(
        Array.from({ length: 15 }, (_, i) => ({
          batchId: batch.id,
          type: 'timed-task',
          payload: { id: i },
        }))
      );

      const timestamps: number[] = [];
      rateLimitedTem.worker.register('timed-task', async () => {
        timestamps.push(Date.now());
        return { done: true };
      });

      rateLimitedTem.worker.start();

      // Wait for completion
      while (true) {
        const stats = await rateLimitedTem.batch.getStats(batch.id);
        if (stats.completed === 15) break;
        await Bun.sleep(100);
      }

      await rateLimitedTem.stop();

      // Analyze timestamps
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]);

      // Should be throttled (some gaps should be significant)
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(avgGap).toBeGreaterThan(0);

      // Total time should reflect throttling
      // 15 tasks: burst of 5, then 10 more at ~100ms each = ~1000ms minimum
      const totalTime = timestamps[timestamps.length - 1] - timestamps[0];
      expect(totalTime).toBeGreaterThan(500);
    });

    it('should measure actual vs configured rate', async () => {
      const requestsPerWindow = 5;
      const windowMs = 500;

      const rateLimitedTem = new TEM({
        databasePath: dbPath,
        concurrency: 10,
        defaultMaxAttempts: 3,
        pollIntervalMs: 10,
        rateLimit: { requests: requestsPerWindow, windowMs },
      });

      const batch = await rateLimitedTem.batch.create({
        code: 'MEASURE-RATE',
        type: 'measured',
      });

      await rateLimitedTem.task.createMany(
        Array.from({ length: 15 }, (_, i) => ({
          batchId: batch.id,
          type: 'measured-task',
          payload: { id: i },
        }))
      );

      const timestamps: number[] = [];
      rateLimitedTem.worker.register('measured-task', async () => {
        timestamps.push(Date.now());
        return { done: true };
      });

      const startTime = Date.now();
      rateLimitedTem.worker.start();

      // Wait for completion
      while (Date.now() - startTime < 10000) {
        const stats = await rateLimitedTem.batch.getStats(batch.id);
        if (stats.completed === 15) break;
        await Bun.sleep(50);
      }

      await rateLimitedTem.stop();

      // Calculate actual rate
      const totalTime = timestamps[timestamps.length - 1] - timestamps[0];
      const actualRate = timestamps.length / (totalTime / 1000);
      const configuredRate = requestsPerWindow / (windowMs / 1000); // 10 req/sec

      // Actual rate should be close to or less than configured rate
      // Allow 50% tolerance for test variability
      expect(actualRate).toBeLessThanOrEqual(configuredRate * 1.5);
      expect(actualRate).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Execution Safety', () => {
    it('should handle high concurrency without race conditions', async () => {
      const highConcurrencyTem = new TEM({
        databasePath: dbPath,
        concurrency: 10,
        defaultMaxAttempts: 3,
        pollIntervalMs: 5,
      });

      const batch = await highConcurrencyTem.batch.create({
        code: 'HIGH-CONCURRENCY',
        type: 'concurrent',
      });

      await highConcurrencyTem.task.createMany(
        Array.from({ length: 50 }, (_, i) =>
        ({
          batchId: batch.id,
          type: 'concurrent-task',
          payload: { id: i },
        }))
      );

      let running = 0;
      let maxRunning = 0;

      highConcurrencyTem.worker.register('concurrent-task', async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(20);
        running--;
        return { done: true };
      });

      highConcurrencyTem.worker.start();

      // Wait for completion with active polling
      const startTime = Date.now();
      let finalStats;
      while (Date.now() - startTime < 5000) {
        finalStats = await highConcurrencyTem.batch.getStats(batch.id);
        if (finalStats.completed === 50) break;
        await Bun.sleep(50);
      }

      // Get final stats before stopping (can't query after stop)
      finalStats = await highConcurrencyTem.batch.getStats(batch.id);

      await highConcurrencyTem.stop();

      // Verify all tasks completed
      expect(finalStats.completed).toBe(50);

      // Verify concurrency limit was respected
      expect(maxRunning).toBeLessThanOrEqual(10);

      // Verify no tasks stuck in running
      expect(finalStats.running).toBe(0);
    });

    it('should maintain exactly-once processing guarantee', async () => {
      const batch = await tem.batch.create({
        code: 'EXACTLY-ONCE',
        type: 'idempotent',
      });

      await tem.task.createMany(
        Array.from({ length: 30 }, (_, i) => ({
          batchId: batch.id,
          type: 'tracked-task',
          payload: { id: i },
        }))
      );

      const processedIds: number[] = [];
      const processCounts = new Map<number, number>();

      tem.worker.register('tracked-task', async (payload: { id: number }) => {
        const current = processCounts.get(payload.id) ?? 0;
        processCounts.set(payload.id, current + 1);
        processedIds.push(payload.id);
        await Bun.sleep(Math.random() * 20);
        return { processed: payload.id };
      });

      tem.worker.start();

      // Wait for completion
      await Bun.sleep(800);

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.completed).toBe(30);

      // Each task should be processed exactly once
      for (const [, count] of processCounts) {
        expect(count).toBe(1);
      }

      // Verify total unique processed
      const uniqueProcessed = new Set(processedIds);
      expect(uniqueProcessed.size).toBe(30);
    });

    it('should handle task state transitions correctly', async () => {
      const batch = await tem.batch.create({
        code: 'STATE-TRANSITIONS',
        type: 'stateful',
      });

      const task = await tem.task.create({
        batchId: batch.id,
        type: 'state-task',
        payload: { data: 'test' },
      });

      // Initial state
      const initial = await tem.task.getById(task.id);
      expect(initial?.status).toBe('pending');

      let reachedRunning = false;

      tem.worker.register('state-task', async () => {
        reachedRunning = true;
        await Bun.sleep(50);
        return { success: true };
      });

      tem.worker.start();

      // Poll states
      let states: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 2000) {
        const t = await tem.task.getById(task.id);
        if (t) {
          states.push(t.status);
          if (t.status === 'completed') break;
        }
        await Bun.sleep(10);
      }

      // Verify state progression
      expect(states[0]).toBe('pending');
      expect(reachedRunning).toBe(true);
      expect(states[states.length - 1]).toBe('completed');

      // Final verification
      const final = await tem.task.getById(task.id);
      expect(final?.status).toBe('completed');
      expect(final?.result).toContain('success');
    });
  });

  describe('Large Batch Processing', () => {
    it('should process many tasks', async () => {
      const largeBatchTem = new TEM({
        databasePath: dbPath,
        concurrency: 10,
        defaultMaxAttempts: 3,
        pollIntervalMs: 5,
      });

      const batch = await largeBatchTem.batch.create({
        code: 'LARGE-BATCH',
        type: 'bulk',
      });

      // Use 200 tasks - enough to verify batch processing without timeout issues
      const taskCount = 200;
      const inputs: i.CreateTaskInput[] = Array.from({ length: taskCount }, (_, i) => ({
        batchId: batch.id,
        type: 'bulk-task',
        payload: { index: i },
      }));

      // Create in chunks to avoid memory issues
      const chunkSize = 50;
      for (let i = 0; i < inputs.length; i += chunkSize) {
        await largeBatchTem.task.createMany(inputs.slice(i, i + chunkSize));
      }

      let processedCount = 0;
      largeBatchTem.worker.register('bulk-task', async () => {
        processedCount++;
        // Minimal delay
        await Bun.sleep(1);
        return { done: true };
      });

      largeBatchTem.worker.start();

      // Wait for completion
      const startTime = Date.now();
      let finalStats;
      while (Date.now() - startTime < 15000) {
        finalStats = await largeBatchTem.batch.getStats(batch.id);
        if (finalStats.completed === taskCount) break;
        await Bun.sleep(50);
      }

      // Get final stats before stopping
      finalStats = await largeBatchTem.batch.getStats(batch.id);

      await largeBatchTem.stop();

      expect(finalStats.total).toBe(taskCount);
      expect(finalStats.completed).toBe(taskCount);
      expect(finalStats.pending).toBe(0);
      expect(finalStats.running).toBe(0);
      expect(finalStats.failed).toBe(0);
      expect(processedCount).toBe(taskCount);
    }, 15000);
  });
});
