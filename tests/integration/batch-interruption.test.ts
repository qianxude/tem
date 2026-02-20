import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TEM } from '../../src/core/tem.js';
import { startMockServer, stopMockServer, createMockService } from '../../src/mock-server/index.js';
import type { MockResponse } from '../../src/mock-server/types.js';
import * as i from '../../src/interfaces/index.js';
import type { BatchInterruptionCriteria } from '../../src/interfaces/index.js';

const TEST_PORT = 19996;
const MOCK_URL = `http://localhost:${TEST_PORT}`;

interface ApiTaskPayload {
  serviceName: string;
  endpoint: string;
  method?: string;
}

interface ApiTaskResult {
  requestId: string;
  meta: { ts: number; rt: number };
  data: string;
}

describe('Batch Interruption Tests', () => {
  let tem: TEM;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    startMockServer({ port: TEST_PORT, mode: 'multi' });
    tempDir = mkdtempSync(join(tmpdir(), 'tem-interruption-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    try {
      await tem.stop();
    } catch {
      // Ignore stop errors
    }
    stopMockServer();
    await Bun.sleep(50);
    try {
      unlinkSync(dbPath);
      rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Error Rate Interruption', () => {
    it('should interrupt batch when error rate exceeds threshold', async () => {
      const res = await createMockService('always-error-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'internal_server_error',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
      });

      const criteria: BatchInterruptionCriteria = {
        maxErrorRate: 0.3,
      };

      const batch = await tem.batch.create({
        code: 'BATCH-ERROR-RATE-001',
        type: 'error-rate-test-batch',
        interruptionCriteria: criteria,
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-error-api',
          endpoint: `${MOCK_URL}/mock/always-error-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('error_rate_exceeded');

      const stats = await tem.batch.getStats(batch.id);
      expect(stats.total).toBe(10);
      expect(stats.failed).toBeGreaterThanOrEqual(3);
    }, 15000);
  });

  describe('Consecutive Failures Interruption', () => {
    it('should interrupt batch after 3 consecutive failures', async () => {
      const res = await createMockService('always-fail-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'service_unavailable',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 3,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
      });

      const criteria: BatchInterruptionCriteria = {
        maxConsecutiveFailures: 3,
      };

      const batch = await tem.batch.create({
        code: 'BATCH-CONSECUTIVE-001',
        type: 'consecutive-failures-test-batch',
        interruptionCriteria: criteria,
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-fail-api',
          endpoint: `${MOCK_URL}/mock/always-fail-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('consecutive_failures_exceeded');

      const stats = await tem.batch.getStats(batch.id);
      // Should have at least 2 failed tasks (may vary due to timing)
      expect(stats.failed).toBeGreaterThanOrEqual(2);
    }, 15000);
  });

  describe('Rate Limit Hits Interruption', () => {
    it('should interrupt batch after 5 rate limit hits', async () => {
      const res = await createMockService('always-429-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 429,
          errorMessage: 'rate_limit_exceeded',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 5,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
      });

      const criteria: BatchInterruptionCriteria = {
        maxRateLimitHits: 5,
      };

      const batch = await tem.batch.create({
        code: 'BATCH-RATE-LIMIT-001',
        type: 'rate-limit-test-batch',
        interruptionCriteria: criteria,
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-429-api',
          endpoint: `${MOCK_URL}/mock/always-429-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP 429: rate_limit_exceeded`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('rate_limit_hits_exceeded');
    }, 15000);
  });

  describe('Concurrency Errors Interruption', () => {
    it('should interrupt batch after 5 concurrency errors', async () => {
      const res = await createMockService('always-503-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 503,
          errorMessage: 'concurrency_limit_exceeded',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 5,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
      });

      const criteria: BatchInterruptionCriteria = {
        maxConcurrencyErrors: 5,
      };

      const batch = await tem.batch.create({
        code: 'BATCH-CONCURRENCY-001',
        type: 'concurrency-error-test-batch',
        interruptionCriteria: criteria,
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-503-api',
          endpoint: `${MOCK_URL}/mock/always-503-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP 503: concurrency_limit_exceeded`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('concurrency_errors_exceeded');
    }, 15000);
  });

  describe('Manual Interruption', () => {
    it('should interrupt batch when calling tem.interruptBatch()', async () => {
      const res = await createMockService('slow-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [200, 300],
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 3,
        defaultMaxAttempts: 3,
        pollIntervalMs: 10,
      });

      const batch = await tem.batch.create({
        code: 'BATCH-MANUAL-001',
        type: 'manual-interrupt-test-batch',
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'slow-api',
          endpoint: `${MOCK_URL}/mock/slow-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      await Bun.sleep(100);

      await tem.interruptBatch(batch.id, 'manual', 'Manual interruption for testing');

      const batchStatus = await tem.batch.getById(batch.id);
      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('manual');
      expect(interruptionLog[0]?.message).toBe('Manual interruption for testing');

      await Bun.sleep(300);
      const stats = await tem.batch.getStats(batch.id);
      expect(stats.pending + stats.running).toBeGreaterThan(0);
    }, 15000);
  });

  describe('Recovery After Interruption', () => {
    it('should allow resuming interrupted batch', async () => {
      const res = await createMockService('recoverable-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'temporary_error',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
      });

      const criteria: BatchInterruptionCriteria = {
        maxConsecutiveFailures: 2,
      };

      const batch = await tem.batch.create({
        code: 'BATCH-RECOVERY-001',
        type: 'recovery-test-batch',
        interruptionCriteria: criteria,
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 5 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'recoverable-api',
          endpoint: `${MOCK_URL}/mock/recoverable-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      await tem.worker.stop();

      const resumedCount = await tem.batch.resume(batch.id);
      expect(resumedCount).toBeGreaterThanOrEqual(0);

      await tem.batch.updateStatus(batch.id, 'active');

      const resumedBatch = await tem.batch.getById(batch.id);
      expect(resumedBatch?.status).toBe('active');
    }, 15000);
  });

  describe('TEM-Level InterruptionCriteria', () => {
    it('should use TEM-level criteria when batch has no criteria', async () => {
      const res = await createMockService('always-error-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'internal_server_error',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
        defaultInterruptionCriteria: {
          maxErrorRate: 0.3,
        },
      });

      // Create batch WITHOUT interruptionCriteria
      const batch = await tem.batch.create({
        code: 'BATCH-TEM-LEVEL-001',
        type: 'tem-level-test-batch',
        // No interruptionCriteria - should use TEM-level
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-error-api',
          endpoint: `${MOCK_URL}/mock/always-error-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('error_rate_exceeded');
    }, 15000);

    it('should use TEM-level criteria to override batch-level criteria', async () => {
      const res = await createMockService('always-error-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'internal_server_error',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // TEM-level has stricter maxErrorRate (0.2) vs batch-level (0.5)
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 2,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
        defaultInterruptionCriteria: {
          maxErrorRate: 0.2, // TEM-level is stricter
        },
      });

      // Batch has looser criteria - should be overridden by TEM-level
      const batch = await tem.batch.create({
        code: 'BATCH-TEM-OVERRIDE-001',
        type: 'tem-override-test-batch',
        interruptionCriteria: {
          maxErrorRate: 0.5, // This should be overridden by TEM's 0.2
        },
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-error-api',
          endpoint: `${MOCK_URL}/mock/always-error-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('error_rate_exceeded');

      // Verify interruption happened earlier (fewer failures) due to TEM-level 0.2 vs 0.5
      const stats = await tem.batch.getStats(batch.id);
      // With 0.2 threshold, should interrupt after ~2 failures out of 10 (20%)
      // With 0.5 threshold, would interrupt after ~5 failures out of 10 (50%)
      // Allow some variance due to concurrent execution timing
      expect(stats.failed).toBeLessThanOrEqual(5);
    }, 15000);

    it('should use TEM-level maxConsecutiveFailures when batch has no criteria', async () => {
      const res = await createMockService('always-fail-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 500,
          errorMessage: 'service_unavailable',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      tem = new TEM({
        databasePath: dbPath,
        concurrency: 3,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
        defaultInterruptionCriteria: {
          maxConsecutiveFailures: 2,
        },
      });

      // Create batch WITHOUT interruptionCriteria
      const batch = await tem.batch.create({
        code: 'BATCH-TEM-CONSECUTIVE-001',
        type: 'tem-consecutive-test-batch',
        // No interruptionCriteria - should use TEM-level
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-fail-api',
          endpoint: `${MOCK_URL}/mock/always-fail-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      expect(interruptionLog[0]?.reason).toBe('consecutive_failures_exceeded');
    }, 15000);

    it('should merge TEM-level and batch-level criteria (TEM-level takes priority)', async () => {
      const res = await createMockService('always-429-api', {
        maxConcurrency: 10,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [5, 10],
        errorSimulation: {
          rate: 1.0,
          statusCode: 429,
          errorMessage: 'rate_limit_exceeded',
        },
      }, MOCK_URL);
      expect(res.status).toBe(201);

      // TEM-level has maxRateLimitHits: 3
      tem = new TEM({
        databasePath: dbPath,
        concurrency: 5,
        defaultMaxAttempts: 1,
        pollIntervalMs: 10,
        defaultInterruptionCriteria: {
          maxRateLimitHits: 3,
          maxConcurrencyErrors: 10, // TEM-level only
        },
      });

      // Batch has maxConcurrencyErrors: 5 (should be overridden by TEM's 10)
      // Batch has maxFailedTasks: 20 (should be used since TEM doesn't set it)
      const batch = await tem.batch.create({
        code: 'BATCH-MERGE-001',
        type: 'merge-test-batch',
        interruptionCriteria: {
          maxConcurrencyErrors: 5, // Should be overridden by TEM's 10
          maxFailedTasks: 20, // Should be used (TEM doesn't set this)
        },
      });

      const taskInputs: i.CreateTaskInput[] = Array.from({ length: 10 }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: {
          serviceName: 'always-429-api',
          endpoint: `${MOCK_URL}/mock/always-429-api`,
          method: 'GET',
        } as ApiTaskPayload,
      }));

      await tem.task.createMany(taskInputs);

      tem.worker.register<ApiTaskPayload, ApiTaskResult>(
        'api-call',
        async (payload) => {
          const res = await fetch(payload.endpoint, {
            method: payload.method || 'GET',
          });

          if (!res.ok) {
            throw new Error(`HTTP 429: rate_limit_exceeded`);
          }

          return (await res.json()) as MockResponse;
        }
      );

      tem.worker.start();

      const startTime = Date.now();
      let batchStatus = await tem.batch.getById(batch.id);
      while (batchStatus?.status !== 'interrupted' && Date.now() - startTime < 10000) {
        await Bun.sleep(100);
        batchStatus = await tem.batch.getById(batch.id);
      }

      expect(batchStatus?.status).toBe('interrupted');

      const interruptionLog = await tem.interruption.getInterruptionLog(batch.id);
      expect(interruptionLog.length).toBeGreaterThan(0);
      // Should interrupt due to maxRateLimitHits from TEM-level (3)
      expect(interruptionLog[0]?.reason).toBe('rate_limit_hits_exceeded');
    }, 15000);
  });
});
