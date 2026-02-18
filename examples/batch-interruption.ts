/**
 * Example: Batch Interruption Mechanism
 *
 * This example demonstrates how the batch interruption mechanism
 * automatically stops a batch when error thresholds are exceeded.
 */
import { TEM, NonRetryableError } from '../src/index.js';
import * as i from '../src/interfaces/index.js';

// Create TEM instance
const tem = new TEM({
  databasePath: './interruption-example.db',
  concurrency: 5,
  defaultMaxAttempts: 2,
  pollIntervalMs: 100,
});

// Register a handler that simulates failures
let callCount = 0;
tem.worker.register('flaky-task', async (_payload: unknown, context: i.TaskContext) => {
  callCount++;

  // Fail 50% of the time after the first few successes
  if (callCount > 3 && Math.random() < 0.5) {
    throw new Error(`Simulated failure #${callCount}`);
  }

  return { result: `Success #${callCount}` };
});

async function runExample() {
  // Create a batch with interruption criteria
  const batch = await tem.batch.create({
    code: 'error-rate-test',
    type: 'test',
    interruptionCriteria: {
      // Interrupt if error rate exceeds 30%
      maxErrorRate: 0.3,
      // Or if more than 10 tasks fail
      maxFailedTasks: 10,
      // Or if 5 consecutive failures occur
      maxConsecutiveFailures: 5,
    },
  });

  console.log(`Created batch ${batch.id} with interruption criteria:`);
  console.log(`  - Max error rate: 30%`);
  console.log(`  - Max failed tasks: 10`);
  console.log(`  - Max consecutive failures: 5`);
  console.log(`  - Initial status: ${batch.status}`);

  // Create 50 tasks that will fail randomly
  const tasks = Array.from({ length: 50 }, (_, i) => ({
    batchId: batch.id,
    type: 'flaky-task',
    payload: { index: i },
  }));

  await tem.task.createMany(tasks);
  console.log(`\nCreated ${tasks.length} tasks`);

  // Start the worker
  console.log('\nStarting worker...\n');
  tem.worker.start();

  // Monitor the batch
  const monitorInterval = setInterval(async () => {
    const stats = await tem.batch.getStats(batch.id);
    const batchInfo = await tem.batch.getById(batch.id);

    console.log(
      `[Monitor] Status: ${batchInfo?.status} | ` +
        `Completed: ${stats.completed} | Failed: ${stats.failed} | ` +
        `Pending: ${stats.pending} | Total: ${stats.total}`
    );

    // Check if batch is interrupted or completed
    if (batchInfo?.status === 'interrupted') {
      console.log('\n⚠️  Batch was interrupted!');
      const interruptions = await tem.interruption.getInterruptionLog(batch.id);
      for (const interruption of interruptions) {
        console.log(`  Reason: ${interruption.reason}`);
        console.log(`  Message: ${interruption.message}`);
        console.log(`  Stats at interruption: ${JSON.stringify(interruption.statsAtInterruption)}`);
      }
    }

    if (batchInfo?.status === 'interrupted' || stats.pending === 0) {
      clearInterval(monitorInterval);
      await tem.stop();

      if (batchInfo?.status !== 'interrupted') {
        console.log('\n✅ Batch completed normally');
      }

      // Show final stats
      const finalStats = await tem.batch.getStats(batch.id);
      console.log('\nFinal stats:');
      console.log(`  Total: ${finalStats.total}`);
      console.log(`  Completed: ${finalStats.completed}`);
      console.log(`  Failed: ${finalStats.failed}`);
      console.log(`  Completion rate: ${((finalStats.completed / finalStats.total) * 100).toFixed(1)}%`);
      console.log(`  Error rate: ${((finalStats.failed / finalStats.total) * 100).toFixed(1)}%`);

      process.exit(0);
    }
  }, 500);
}

runExample().catch((error) => {
  console.error('Example failed:', error);
  process.exit(1);
});
