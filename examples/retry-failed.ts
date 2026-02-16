import { TEM } from '../src/core/tem.js';
import { NonRetryableError } from '../src/core/worker.js';

/**
 * Retry Failed Tasks Example
 *
 * This demonstrates:
 * 1. Processing tasks with some failures
 * 2. Analyzing failure stats via batch.getStats()
 * 3. Using batch.retryFailed() to retry failed tasks
 * 4. Handling permanent failures
 */

async function main() {
  const tem = new TEM({
    databasePath: './retry-failed-example.db',
    concurrency: 3,
    defaultMaxAttempts: 2,
    pollIntervalMs: 50,
  });

  try {
    console.log('=== Retry Failed Tasks Demo ===\n');

    // Create batch
    const batch = await tem.batch.create({
      code: 'RETRY-DEMO',
      type: 'mixed-success',
    });

    // Create tasks with known outcomes
    // Tasks 1-3: Will eventually succeed
    // Tasks 4-5: Will always fail (retryable)
    // Task 6: Will fail immediately (non-retryable)
    const tasks = await tem.task.createMany([
      { batchId: batch.id, type: 'unstable', payload: { id: 1, failFirst: 1 } },
      { batchId: batch.id, type: 'unstable', payload: { id: 2, failFirst: 2 } },
      { batchId: batch.id, type: 'unstable', payload: { id: 3, failFirst: 0 } }, // Always succeeds
      { batchId: batch.id, type: 'broken', payload: { id: 4 } },
      { batchId: batch.id, type: 'broken', payload: { id: 5 } },
      { batchId: batch.id, type: 'invalid', payload: { id: 6 } },
    ]);

    console.log(`Created ${tasks.length} tasks`);

    // Track attempts
    const attemptCounts = new Map<number, number>();

    // Register handlers
    tem.worker.register('unstable', async (payload: { id: number; failFirst: number }) => {
      const attempts = (attemptCounts.get(payload.id) ?? 0) + 1;
      attemptCounts.set(payload.id, attempts);

      console.log(`  [unstable-${payload.id}] Attempt ${attempts}`);

      if (attempts <= payload.failFirst) {
        throw new Error(`Temporary failure on attempt ${attempts}`);
      }

      console.log(`    ✓ Success after ${attempts} attempt(s)`);
      return { success: true, attempts };
    });

    tem.worker.register('broken', async (payload: { id: number }) => {
      const attempts = (attemptCounts.get(payload.id) ?? 0) + 1;
      attemptCounts.set(payload.id, attempts);

      console.log(`  [broken-${payload.id}] Attempt ${attempts} - always fails`);
      throw new Error('Service permanently unavailable');
    });

    tem.worker.register('invalid', async (payload: { id: number }) => {
      console.log(`  [invalid-${payload.id}] Non-retryable error`);
      throw new NonRetryableError('Invalid input data');
    });

    // Start processing
    console.log('\n--- Initial Processing ---\n');
    tem.worker.start();

    // Wait for initial processing to complete
    while (true) {
      const stats = await tem.batch.getStats(batch.id);
      if (stats.pending === 0 && stats.running === 0) {
        break;
      }
      await Bun.sleep(100);
    }

    // Show initial results
    console.log('\n--- Initial Results ---');
    const stats1 = await tem.batch.getStats(batch.id);
    console.log(`Total: ${stats1.total}`);
    console.log(`Completed: ${stats1.completed}`);
    console.log(`Failed: ${stats1.failed}`);

    // Show details of failed tasks
    console.log('\n--- Failed Tasks Analysis ---');
    for (const task of tasks) {
      const t = await tem.task.getById(task.id);
      if (t?.status === 'failed') {
        console.log(`  Task ${t.id.slice(0, 8)}...: ${t.error}`);
      }
    }

    // Retry failed tasks
    console.log('\n--- Retrying Failed Tasks ---');
    const retried = await tem.batch.retryFailed(batch.id);
    console.log(`Reset ${retried} failed tasks to pending\n`);

    // Wait for retry processing
    while (true) {
      const stats = await tem.batch.getStats(batch.id);
      if (stats.pending === 0 && stats.running === 0) {
        break;
      }
      await Bun.sleep(100);
    }

    // Show final results
    console.log('\n--- Final Results After Retry ---');
    const stats2 = await tem.batch.getStats(batch.id);
    console.log(`Total: ${stats2.total}`);
    console.log(`Completed: ${stats2.completed}`);
    console.log(`Failed: ${stats2.failed}`);

    // Show which tasks eventually succeeded
    console.log('\n--- Task Summary ---');
    for (const task of tasks) {
      const t = await tem.task.getById(task.id);
      const status = t?.status === 'completed' ? '✓ Completed' : '✗ Failed';
      // should parse and get id from payload
      const payload = JSON.parse(task.payload);
      const attempts = attemptCounts.get(payload.id as number) ?? 0;
      console.log(`  Task ${payload.id}: ${status} (${attempts} attempt(s))`);
    }

    // Explanation
    console.log('\n--- Notes ---');
    console.log('- Tasks 1-3: Eventually succeeded after retries');
    console.log('- Tasks 4-5: Failed after exhausting max attempts (2)');
    console.log('- Task 6: Failed immediately (NonRetryableError)');
  } finally {
    await tem.stop();
    console.log('\nTEM stopped');
  }
}

main().catch(console.error);
