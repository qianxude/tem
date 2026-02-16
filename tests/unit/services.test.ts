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
  });
});
