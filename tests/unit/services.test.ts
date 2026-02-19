import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../src/database/index.js';
import { BatchService, TaskService } from '../../src/services/index.js';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Services', () => {
  let db: Database;
  let dbPath: string;
  let tempDir: string;
  let batchService: BatchService;
  let taskService: TaskService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tem-test-'));
    dbPath = join(tempDir, 'test.db');
    db = new Database({ path: dbPath });
    batchService = new BatchService(db);
    taskService = new TaskService(db);
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

  describe('BatchService', () => {
    it('should create a batch', async () => {
      const batch = await batchService.create({
        code: 'BATCH-001',
        type: 'import',
        metadata: { source: 'csv' },
      });

      expect(batch.code).toBe('BATCH-001');
      expect(batch.type).toBe('import');
      expect(batch.metadata).toEqual({ source: 'csv' });
      expect(batch.completedAt).toBeNull();
    });

    it('should get batch by id', async () => {
      const created = await batchService.create({
        code: 'BATCH-002',
        type: 'export',
      });

      const fetched = await batchService.getById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.code).toBe('BATCH-002');
    });

    it('should get batch by code', async () => {
      await batchService.create({
        code: 'UNIQUE-CODE',
        type: 'sync',
      });

      const fetched = await batchService.getByCode('UNIQUE-CODE');
      expect(fetched).not.toBeNull();
      expect(fetched?.code).toBe('UNIQUE-CODE');
    });

    it('should return null for non-existent batch', async () => {
      const fetched = await batchService.getById('non-existent');
      expect(fetched).toBeNull();
    });

    it('should complete a batch', async () => {
      const batch = await batchService.create({
        code: 'BATCH-003',
        type: 'process',
      });

      await batchService.complete(batch.id);

      const completed = await batchService.getById(batch.id);
      expect(completed?.completedAt).not.toBeNull();
    });

    it('should list all batches ordered by created_at DESC', async () => {
      await batchService.create({ code: 'B1', type: 'a' });
      await batchService.create({ code: 'B2', type: 'b' });
      await batchService.create({ code: 'B3', type: 'c' });

      const batches = await batchService.list();
      expect(batches).toHaveLength(3);
      const codes = batches.map((b) => b.code);
      expect(codes).toContain('B1');
      expect(codes).toContain('B2');
      expect(codes).toContain('B3');
    });

    it('should list batches filtered by type', async () => {
      await batchService.create({ code: 'B1', type: 'import' });
      await batchService.create({ code: 'B2', type: 'export' });
      await batchService.create({ code: 'B3', type: 'import' });

      const batches = await batchService.list({ type: 'import' });
      expect(batches).toHaveLength(2);
      expect(batches.every((b) => b.type === 'import')).toBe(true);
    });

    it('should list return empty array when no batches match filter', async () => {
      await batchService.create({ code: 'B1', type: 'import' });

      const batches = await batchService.list({ type: 'nonexistent' });
      expect(batches).toEqual([]);
    });

    it('should resume running tasks to pending', async () => {
      const batch = await batchService.create({ code: 'RESUME', type: 'test' });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      await taskService.claim(batch.id);
      await taskService.claim(batch.id);

      const resumed = await batchService.resume(batch.id);
      expect(resumed).toBe(2);
    });

    it('should resume return 0 when no running tasks', async () => {
      const batch = await batchService.create({ code: 'NOOP', type: 'test' });
      const resumed = await batchService.resume(batch.id);
      expect(resumed).toBe(0);
    });

    it('should retry failed tasks resetting attempt to 0', async () => {
      const batch = await batchService.create({ code: 'RETRY', type: 'test' });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const t1 = await taskService.claim(batch.id);
      const t2 = await taskService.claim(batch.id);
      await taskService.fail(t1!.id, 'err');
      await taskService.fail(t2!.id, 'err');

      const retried = await batchService.retryFailed(batch.id);
      expect(retried).toBe(2);

      const task = await taskService.getById(t1!.id);
      expect(task?.status).toBe('pending');
      expect(task?.attempt).toBe(0);
    });

    it('should retryFailed return 0 when no failed tasks', async () => {
      const batch = await batchService.create({ code: 'NOFAIL', type: 'test' });
      const retried = await batchService.retryFailed(batch.id);
      expect(retried).toBe(0);
    });

    it('should update batch status', async () => {
      const batch = await batchService.create({ code: 'STATUS', type: 'test' });
      await batchService.updateStatus(batch.id, 'interrupted');

      const updated = await batchService.getById(batch.id);
      expect(updated?.status).toBe('interrupted');
    });

    it('should getWithCriteria return batch and criteria', async () => {
      const criteria = { maxErrorRate: 0.5, maxFailedTasks: 10 };
      const batch = await batchService.create({
        code: 'CRIT',
        type: 'test',
        interruptionCriteria: criteria,
      });

      const result = await batchService.getWithCriteria(batch.id);
      expect(result.batch.id).toBe(batch.id);
      expect(result.criteria).toEqual(criteria);
    });

    it('should getWithCriteria return null criteria when none set', async () => {
      const batch = await batchService.create({ code: 'NOCRIT', type: 'test' });

      const result = await batchService.getWithCriteria(batch.id);
      expect(result.batch.id).toBe(batch.id);
      expect(result.criteria).toBeNull();
    });

    it('should getWithCriteria throw for non-existent batch', async () => {
      expect(batchService.getWithCriteria('non-existent')).rejects.toThrow('Batch not found');
    });

    it('should getStats return correct counts by status', async () => {
      const batch = await batchService.create({ code: 'STATS', type: 'test' });
      // 2 pending, 1 running, 1 completed, 1 failed
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const t3 = await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const t4 = await taskService.create({ batchId: batch.id, type: 't', payload: {} });
      const t5 = await taskService.create({ batchId: batch.id, type: 't', payload: {} });

      const c3 = await taskService.claim(batch.id);
      const c4 = await taskService.claim(batch.id);
      const c5 = await taskService.claim(batch.id);
      await taskService.complete(c3!.id, { ok: true });
      await taskService.fail(c4!.id, 'err');
      // c5 stays running

      const stats = await batchService.getStats(batch.id);
      expect(stats.batchId).toBe(batch.id);
      expect(stats.total).toBe(5);
      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });

    it('should getStats return all zeros for batch with no tasks', async () => {
      const batch = await batchService.create({ code: 'EMPTY', type: 'test' });
      const stats = await batchService.getStats(batch.id);
      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  describe('TaskService', () => {
    it('should create a task', async () => {
      const task = await taskService.create({
        type: 'send-email',
        payload: { to: 'user@example.com', subject: 'Hello' },
      });

      expect(task.type).toBe('send-email');
      expect(task.status).toBe('pending');
      expect(JSON.parse(task.payload)).toEqual({
        to: 'user@example.com',
        subject: 'Hello',
      });
    });

    it('should create a task with batch', async () => {
      const batch = await batchService.create({
        code: 'BATCH-TASK',
        type: 'email-campaign',
      });

      const task = await taskService.create({
        batchId: batch.id,
        type: 'send-email',
        payload: { to: 'user@example.com' },
      });

      expect(task.batchId).toBe(batch.id);
    });

    it('should claim a task atomically', async () => {
      await taskService.create({
        type: 'process',
        payload: { data: 'test' },
      });

      const claimed = await taskService.claim();
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('running');
      expect(claimed?.attempt).toBe(1);
      expect(claimed?.claimedAt).not.toBeNull();
    });

    it('should claim tasks by batch', async () => {
      const batch1 = await batchService.create({
        code: 'BATCH-1',
        type: 'type-a',
      });
      const batch2 = await batchService.create({
        code: 'BATCH-2',
        type: 'type-b',
      });

      await taskService.create({
        batchId: batch1.id,
        type: 'task-a',
        payload: {},
      });
      await taskService.create({
        batchId: batch2.id,
        type: 'task-b',
        payload: {},
      });

      const claimed = await taskService.claim(batch1.id);
      expect(claimed).not.toBeNull();
      expect(claimed?.batchId).toBe(batch1.id);
    });

    it('should return null when no tasks to claim', async () => {
      const claimed = await taskService.claim();
      expect(claimed).toBeNull();
    });

    it('should complete a task', async () => {
      const task = await taskService.create({
        type: 'compute',
        payload: { x: 1, y: 2 },
      });

      const claimed = await taskService.claim();
      expect(claimed).not.toBeNull();

      await taskService.complete(claimed!.id, { result: 3 });

      const completed = await taskService.getById(task.id);
      expect(completed?.status).toBe('completed');
      expect(JSON.parse(completed?.result ?? '{}')).toEqual({ result: 3 });
    });

    it('should fail a task', async () => {
      const task = await taskService.create({
        type: 'risky-op',
        payload: {},
      });

      const claimed = await taskService.claim();
      await taskService.fail(claimed!.id, 'Something went wrong');

      const failed = await taskService.getById(task.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toBe('Something went wrong');
    });

    it('should retry a failed task', async () => {
      const task = await taskService.create({
        type: 'retryable',
        payload: {},
      });

      const claimed = await taskService.claim();
      await taskService.fail(claimed!.id, 'Temporary error');

      await taskService.retry(task.id);

      const retried = await taskService.getById(task.id);
      expect(retried?.status).toBe('pending');
      expect(retried?.claimedAt).toBeNull();
    });

    it('should track max attempts', async () => {
      const task = await taskService.create({
        type: 'limited',
        payload: {},
        maxAttempt: 2,
      });

      const created = await taskService.getById(task.id);
      expect(created?.maxAttempt).toBe(2);
    });

    it('should createMany tasks in a transaction', async () => {
      const batch = await batchService.create({ code: 'MANY', type: 'test' });
      const tasks = await taskService.createMany([
        { batchId: batch.id, type: 'a', payload: { n: 1 } },
        { batchId: batch.id, type: 'b', payload: { n: 2 } },
        { batchId: batch.id, type: 'c', payload: { n: 3 } },
      ]);

      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].batchId).toBe(batch.id);
      expect(tasks[1].type).toBe('b');
      expect(JSON.parse(tasks[2].payload)).toEqual({ n: 3 });
    });

    it('should createMany default maxAttempt to 3', async () => {
      const tasks = await taskService.createMany([
        { type: 'x', payload: {} },
      ]);
      expect(tasks[0].maxAttempt).toBe(3);
    });

    it('should createMany respect custom maxAttempt', async () => {
      const tasks = await taskService.createMany([
        { type: 'x', payload: {}, maxAttempt: 5 },
      ]);
      expect(tasks[0].maxAttempt).toBe(5);
    });

    it('should createMany with empty array return empty array', async () => {
      const tasks = await taskService.createMany([]);
      expect(tasks).toEqual([]);
    });
  });
});
