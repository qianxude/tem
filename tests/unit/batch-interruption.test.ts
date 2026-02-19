import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../src/database/index.js';
import { BatchService, TaskService, BatchInterruptionService } from '../../src/services/index.js';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('BatchInterruptionService', () => {
  let db: Database;
  let dbPath: string;
  let tempDir: string;
  let batchService: BatchService;
  let taskService: TaskService;
  let interruptionService: BatchInterruptionService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tem-test-'));
    dbPath = join(tempDir, 'test.db');
    db = new Database({ path: dbPath });
    batchService = new BatchService(db);
    taskService = new TaskService(db);
    interruptionService = new BatchInterruptionService(db, batchService);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
      rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('isBatchActive', () => {
    it('should return true for active batch', async () => {
      const batch = await batchService.create({ code: 'ACTIVE', type: 'test' });
      expect(await interruptionService.isBatchActive(batch.id)).toBe(true);
    });

    it('should return false for interrupted batch', async () => {
      const batch = await batchService.create({ code: 'INT', type: 'test' });
      await batchService.updateStatus(batch.id, 'interrupted');
      expect(await interruptionService.isBatchActive(batch.id)).toBe(false);
    });

    it('should return false for completed batch', async () => {
      const batch = await batchService.create({ code: 'COMP', type: 'test' });
      await batchService.updateStatus(batch.id, 'completed');
      expect(await interruptionService.isBatchActive(batch.id)).toBe(false);
    });

    it('should return false for non-existent batch', async () => {
      expect(await interruptionService.isBatchActive('no-such-id')).toBe(false);
    });
  });

  describe('interrupt', () => {
    it('should set batch status to interrupted and log the event', async () => {
      const batch = await batchService.create({ code: 'INT1', type: 'test' });
      await interruptionService.interrupt(batch.id, 'manual', 'User requested');

      const updated = await batchService.getById(batch.id);
      expect(updated?.status).toBe('interrupted');

      const log = await interruptionService.getInterruptionLog(batch.id);
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('manual');
      expect(log[0].message).toBe('User requested');
    });

    it('should record stats snapshot at time of interruption', async () => {
      const batch = await batchService.create({ code: 'SNAP', type: 'test' });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const claimed = await taskService.claim(batch.id);
      await taskService.fail(claimed!.id, 'err');

      await interruptionService.interrupt(batch.id, 'manual', 'stop');

      const log = await interruptionService.getInterruptionLog(batch.id);
      expect(log[0].statsAtInterruption.failed).toBe(1);
      expect(log[0].statsAtInterruption.total).toBe(1);
    });
  });

  describe('getInterruptionLog', () => {
    it('should return empty array for batch with no interruptions', async () => {
      const batch = await batchService.create({ code: 'NOLOG', type: 'test' });
      const log = await interruptionService.getInterruptionLog(batch.id);
      expect(log).toEqual([]);
    });

    it('should return multiple entries ordered by created_at DESC', async () => {
      const batch = await batchService.create({ code: 'MULTI', type: 'test' });
      await interruptionService.interrupt(batch.id, 'manual', 'first');
      await batchService.updateStatus(batch.id, 'active');
      await Bun.sleep(5);
      await interruptionService.interrupt(batch.id, 'manual', 'second');

      const log = await interruptionService.getInterruptionLog(batch.id);
      expect(log).toHaveLength(2);
      expect(log[0].message).toBe('second');
      expect(log[1].message).toBe('first');
    });
  });

  describe('checkAndInterruptIfNeeded', () => {
    it('should return false when batch is not active', async () => {
      const batch = await batchService.create({
        code: 'INACTIVE',
        type: 'test',
        interruptionCriteria: { maxFailedTasks: 1 },
      });
      await batchService.updateStatus(batch.id, 'interrupted');

      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });

    it('should return false when no interruption criteria set', async () => {
      const batch = await batchService.create({ code: 'NOCRIT', type: 'test' });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });

    it('should return false when no criteria are exceeded', async () => {
      const batch = await batchService.create({
        code: 'SAFE',
        type: 'test',
        interruptionCriteria: { maxFailedTasks: 100 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });
    it('should interrupt on maxBatchRuntimeMs exceeded', async () => {
      const batch = await batchService.create({
        code: 'RUNTIME',
        type: 'test',
        interruptionCriteria: { maxBatchRuntimeMs: 1 },
      });
      // Ensure at least 2ms have elapsed so runtime > 1ms threshold
      await Bun.sleep(5);
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(true);

      const updated = await batchService.getById(batch.id);
      expect(updated?.status).toBe('interrupted');
    });

    it('should interrupt on taskTimeoutMs exceeded', async () => {
      const batch = await batchService.create({
        code: 'TIMEOUT',
        type: 'test',
        interruptionCriteria: { taskTimeoutMs: 1000 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        currentTaskRuntimeMs: 2000,
      });
      expect(result).toBe(true);
    });

    it('should not interrupt on taskTimeoutMs when currentTaskRuntimeMs not provided', async () => {
      const batch = await batchService.create({
        code: 'NOTIMEOUT',
        type: 'test',
        interruptionCriteria: { taskTimeoutMs: 1000 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });

    it('should interrupt on maxConsecutiveFailures exceeded', async () => {
      const batch = await batchService.create({
        code: 'CONSEC',
        type: 'test',
        interruptionCriteria: { maxConsecutiveFailures: 3 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        consecutiveFailures: 3,
      });
      expect(result).toBe(true);
    });

    it('should not interrupt when consecutiveFailures below threshold', async () => {
      const batch = await batchService.create({
        code: 'LOWFAIL',
        type: 'test',
        interruptionCriteria: { maxConsecutiveFailures: 5 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        consecutiveFailures: 2,
      });
      expect(result).toBe(false);
    });

    it('should interrupt on maxRateLimitHits exceeded', async () => {
      const batch = await batchService.create({
        code: 'RATELIMIT',
        type: 'test',
        interruptionCriteria: { maxRateLimitHits: 5 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        rateLimitHits: 5,
      });
      expect(result).toBe(true);
    });

    it('should interrupt on maxConcurrencyErrors exceeded', async () => {
      const batch = await batchService.create({
        code: 'CONCERR',
        type: 'test',
        interruptionCriteria: { maxConcurrencyErrors: 3 },
      });
      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        concurrencyErrors: 3,
      });
      expect(result).toBe(true);
    });
    it('should interrupt on maxFailedTasks exceeded', async () => {
      const batch = await batchService.create({
        code: 'MAXFAIL',
        type: 'test',
        interruptionCriteria: { maxFailedTasks: 2 },
      });
      // Create and fail 2 tasks
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const c1 = await taskService.claim(batch.id);
      const c2 = await taskService.claim(batch.id);
      await taskService.fail(c1!.id, 'err');
      await taskService.fail(c2!.id, 'err');

      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(true);
    });

    it('should not interrupt on maxFailedTasks when below threshold', async () => {
      const batch = await batchService.create({
        code: 'BELOWFAIL',
        type: 'test',
        interruptionCriteria: { maxFailedTasks: 5 },
      });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const c1 = await taskService.claim(batch.id);
      await taskService.fail(c1!.id, 'err');

      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });

    it('should interrupt on maxErrorRate exceeded', async () => {
      const batch = await batchService.create({
        code: 'ERRRATE',
        type: 'test',
        interruptionCriteria: { maxErrorRate: 0.3 },
      });
      // 4 tasks, fail 2 => 50% > 30%
      for (let n = 0; n < 4; n++) {
        await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      }
      const c1 = await taskService.claim(batch.id);
      const c2 = await taskService.claim(batch.id);
      const c3 = await taskService.claim(batch.id);
      const c4 = await taskService.claim(batch.id);
      await taskService.complete(c1!.id, {});
      await taskService.complete(c2!.id, {});
      await taskService.fail(c3!.id, 'err');
      await taskService.fail(c4!.id, 'err');

      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(true);
    });

    it('should not interrupt on maxErrorRate when rate is below threshold', async () => {
      const batch = await batchService.create({
        code: 'LOWRATE',
        type: 'test',
        interruptionCriteria: { maxErrorRate: 0.5 },
      });
      // 4 tasks, fail 1 => 25% < 50%
      for (let n = 0; n < 4; n++) {
        await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      }
      const c1 = await taskService.claim(batch.id);
      const c2 = await taskService.claim(batch.id);
      const c3 = await taskService.claim(batch.id);
      const c4 = await taskService.claim(batch.id);
      await taskService.complete(c1!.id, {});
      await taskService.complete(c2!.id, {});
      await taskService.complete(c3!.id, {});
      await taskService.fail(c4!.id, 'err');

      const result = await interruptionService.checkAndInterruptIfNeeded(batch.id, {});
      expect(result).toBe(false);
    });

    it('should check criteria in priority order', async () => {
      const batch = await batchService.create({
        code: 'PRIORITY',
        type: 'test',
        interruptionCriteria: {
          maxBatchRuntimeMs: 1,
          maxConsecutiveFailures: 2,
        },
      });

      await Bun.sleep(5);
      await interruptionService.checkAndInterruptIfNeeded(batch.id, {
        consecutiveFailures: 5,
      });

      // Should have interrupted on batch_runtime_exceeded (checked first)
      const log = await interruptionService.getInterruptionLog(batch.id);
      expect(log).toHaveLength(1);
      expect(log[0].reason).toBe('batch_runtime_exceeded');
    });
  });
});
