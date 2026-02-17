import { TEM } from '../core/tem.js';
import type { BatchStats } from '../interfaces/index.js';

export interface WaitForBatchOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Waits for a batch to complete by polling its statistics.
 * Logs progress at each interval showing completion percentage and task counts.
 *
 * @param tem - TEM instance
 * @param batchId - ID of the batch to monitor
 * @param options - Optional configuration
 * @param options.timeoutMs - Maximum time to wait in milliseconds (default: 30000)
 * @param options.intervalMs - Polling interval in milliseconds (default: 1000)
 * @returns Promise that resolves when batch is complete
 * @throws Error if timeout is reached before completion
 */
export async function waitForBatch(
  tem: TEM,
  batchId: string,
  options: WaitForBatchOptions = {}
): Promise<void> {
  const { timeoutMs = 30000, intervalMs = 1000 } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const stats: BatchStats = await tem.batch.getStats(batchId);

    const total = stats.total;
    const completed = stats.completed;
    const failed = stats.failed;
    const pending = stats.pending;
    const running = stats.running;

    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    console.log(
      `[BatchMonitor] Batch ${batchId}: ${percent}% complete (${completed}/${total}) - completed:${completed} failed:${failed} pending:${pending} running:${running}`
    );

    if (pending === 0 && running === 0) {
      return;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error('Batch completion timeout');
}
