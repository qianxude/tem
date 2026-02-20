import * as i from '../interfaces/index.js';
import type { Database } from '../database/index.js';
import type { BatchService } from './batch.js';

export interface BatchInterruptionRow {
  batch_id: string;
  reason: i.BatchInterruptionReason;
  message: string;
  stats_snapshot: string;
  created_at: string;
}

export class BatchInterruptionService implements i.BatchInterruptionService {
  constructor(
    private db: Database,
    private batchService: BatchService,
    private defaultCriteria?: i.BatchInterruptionCriteria
  ) {}

  /**
   * Check if batch should be interrupted based on current stats.
   * Called after each task failure or periodically.
   */
  async checkAndInterruptIfNeeded(
    batchId: string,
    context: {
      consecutiveFailures?: number;
      rateLimitHits?: number;
      concurrencyErrors?: number;
      currentTaskRuntimeMs?: number;
    }
  ): Promise<boolean> {
    // Fetch batch with its interruption criteria
    const { batch, criteria: batchCriteria } = await this.batchService.getWithCriteria(batchId);

    // If already interrupted or completed, no need to check
    if (batch.status !== 'active') {
      return false;
    }

    // Merge criteria: TEM-level (default) overrides batch-level
    const criteria: i.BatchInterruptionCriteria | undefined = batchCriteria || this.defaultCriteria
      ? { ...batchCriteria, ...this.defaultCriteria }
      : undefined;

    // If no criteria set, never interrupt
    if (!criteria) {
      return false;
    }

    // Get current stats
    const stats = await this.batchService.getStats(batchId);

    // Check each criterion in order of severity

    // 1. Check maxBatchRuntimeMs - total batch runtime
    if (criteria.maxBatchRuntimeMs) {
      const batchRuntimeMs = Date.now() - batch.createdAt.getTime();
      if (batchRuntimeMs > criteria.maxBatchRuntimeMs) {
        await this.interrupt(
          batchId,
          'batch_runtime_exceeded',
          `Batch runtime (${batchRuntimeMs}ms) exceeded maximum (${criteria.maxBatchRuntimeMs}ms)`
        );
        return true;
      }
    }

    // 2. Check taskTimeoutMs - single task runtime
    if (criteria.taskTimeoutMs && context.currentTaskRuntimeMs) {
      if (context.currentTaskRuntimeMs > criteria.taskTimeoutMs) {
        await this.interrupt(
          batchId,
          'task_timeout',
          `Task runtime (${context.currentTaskRuntimeMs}ms) exceeded maximum (${criteria.taskTimeoutMs}ms)`
        );
        return true;
      }
    }

    // 3. Check maxConsecutiveFailures
    if (criteria.maxConsecutiveFailures && context.consecutiveFailures) {
      if (context.consecutiveFailures >= criteria.maxConsecutiveFailures) {
        await this.interrupt(
          batchId,
          'consecutive_failures_exceeded',
          `Consecutive failures (${context.consecutiveFailures}) exceeded maximum (${criteria.maxConsecutiveFailures})`
        );
        return true;
      }
    }

    // 4. Check maxRateLimitHits
    if (criteria.maxRateLimitHits && context.rateLimitHits) {
      if (context.rateLimitHits >= criteria.maxRateLimitHits) {
        await this.interrupt(
          batchId,
          'rate_limit_hits_exceeded',
          `Rate limit hits (${context.rateLimitHits}) exceeded maximum (${criteria.maxRateLimitHits})`
        );
        return true;
      }
    }

    // 5. Check maxConcurrencyErrors (502/503 errors)
    if (criteria.maxConcurrencyErrors && context.concurrencyErrors) {
      if (context.concurrencyErrors >= criteria.maxConcurrencyErrors) {
        await this.interrupt(
          batchId,
          'concurrency_errors_exceeded',
          `Concurrency errors (${context.concurrencyErrors}) exceeded maximum (${criteria.maxConcurrencyErrors})`
        );
        return true;
      }
    }

    // 6. Check maxFailedTasks (absolute count)
    if (criteria.maxFailedTasks) {
      if (stats.failed >= criteria.maxFailedTasks) {
        await this.interrupt(
          batchId,
          'failed_tasks_exceeded',
          `Failed tasks (${stats.failed}) exceeded maximum (${criteria.maxFailedTasks})`
        );
        return true;
      }
    }

    // 7. Check maxErrorRate (percentage)
    if (criteria.maxErrorRate && stats.total > 0) {
      const errorRate = stats.failed / stats.total;
      if (errorRate > criteria.maxErrorRate) {
        await this.interrupt(
          batchId,
          'error_rate_exceeded',
          `Error rate (${(errorRate * 100).toFixed(1)}%) exceeded maximum (${(criteria.maxErrorRate * 100).toFixed(1)}%)`
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Interrupt a batch atomically.
   */
  async interrupt(
    batchId: string,
    reason: i.BatchInterruptionReason,
    message: string
  ): Promise<void> {
    // Get current stats for the log
    const stats = await this.batchService.getStats(batchId);

    // Update batch status to 'interrupted'
    await this.batchService.updateStatus(batchId, 'interrupted');

    // Log the interruption event
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO batch_interrupt_log (id, batch_id, reason, message, stats_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, batchId, reason, message, JSON.stringify(stats), now]
    );
  }

  /**
   * Check if a batch is active (can claim tasks from it).
   */
  async isBatchActive(batchId: string): Promise<boolean> {
    const batch = await this.batchService.getById(batchId);
    return batch?.status === 'active';
  }

  /**
   * Get interruption history for a batch.
   */
  async getInterruptionLog(batchId: string): Promise<i.BatchInterruption[]> {
    const rows = this.db.query<BatchInterruptionRow>(
      `SELECT batch_id, reason, message, stats_snapshot, created_at
       FROM batch_interrupt_log
       WHERE batch_id = ?
       ORDER BY created_at DESC`,
      [batchId]
    );

    return rows.map((row) => ({
      batchId: row.batch_id,
      reason: row.reason,
      message: row.message,
      statsAtInterruption: JSON.parse(row.stats_snapshot) as i.BatchStats,
      createdAt: new Date(row.created_at),
    }));
  }
}
