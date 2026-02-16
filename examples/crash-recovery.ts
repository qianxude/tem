import { TEM } from '../src/core/tem.js';

/**
 * Crash Recovery Example
 *
 * This demonstrates how to recover from a simulated crash:
 * 1. Start processing a batch
 * 2. Simulate a crash (stop without cleanup)
 * 3. Restart and recover using batch.resume()
 * 4. Complete remaining tasks
 */

const DB_PATH = './crash-recovery-example.db';

async function simulateCrash(): Promise<string> {
  console.log('=== Phase 1: Starting work (will crash) ===\n');

  const tem = new TEM({
    databasePath: DB_PATH,
    concurrency: 2,
    defaultMaxAttempts: 3,
    pollIntervalMs: 50,
  });

  // Create batch and tasks
  const batch = await tem.batch.create({
    code: 'CRASH-DEMO',
    type: 'interruptible',
  });

  await tem.task.createMany(
    Array.from({ length: 10 }, (_, i) => ({
      batchId: batch.id,
      type: 'slow-task',
      payload: { id: i + 1 },
    }))
  );

  console.log(`Created batch ${batch.code} with 10 tasks\n`);

  // Register slow handler
  tem.worker.register('slow-task', async (payload: { id: number }) => {
    console.log(`  Processing task ${payload.id}...`);
    await Bun.sleep(500); // Slow work
    console.log(`  ✓ Task ${payload.id} completed`);
    return { done: true };
  });

  // Start processing
  tem.worker.start();

  // Wait a bit for some tasks to start
  await Bun.sleep(150);

  // Check current state before crash
  const statsBefore = await tem.batch.getStats(batch.id);
  console.log(`\n--- CRASHING HERE ---`);
  console.log(`State at crash: ${statsBefore.pending} pending, ${statsBefore.running} running\n`);

  // Abrupt stop (simulating crash)
  await tem.stop();

  return batch.id;
}

async function recoverAndComplete(batchId: string): Promise<void> {
  console.log('=== Phase 2: Recovery ===\n');

  // Re-initialize TEM (as if after restart)
  const tem = new TEM({
    databasePath: DB_PATH,
    concurrency: 2,
    defaultMaxAttempts: 3,
    pollIntervalMs: 50,
  });

  // Get batch state before resume
  const statsBefore = await tem.batch.getStats(batchId);
  console.log(`Before resume: ${statsBefore.pending} pending, ${statsBefore.running} running`);

  // Resume the batch - resets 'running' tasks to 'pending'
  const resumedCount = await tem.batch.resume(batchId);
  console.log(`Resumed ${resumedCount} running tasks back to pending`);

  // Check state after resume
  const statsAfter = await tem.batch.getStats(batchId);
  console.log(`After resume: ${statsAfter.pending} pending, ${statsAfter.running} running\n`);

  // Register handler again
  tem.worker.register('slow-task', async (payload: { id: number }) => {
    console.log(`  Processing task ${payload.id}...`);
    await Bun.sleep(100); // Faster this time
    console.log(`  ✓ Task ${payload.id} completed`);
    return { done: true };
  });

  // Restart processing
  console.log('Restarting worker...\n');
  tem.worker.start();

  // Monitor until complete
  while (true) {
    const stats = await tem.batch.getStats(batchId);
    console.log(`Progress: ${stats.completed}/${stats.total} completed`);

    if (stats.completed === stats.total) {
      break;
    }

    await Bun.sleep(200);
  }

  console.log('\n✓ All tasks completed successfully!');

  await tem.stop();
}

async function main() {
  // Clean up any previous run
  try {
    await Bun.file(DB_PATH).delete();
  } catch {
    // Ignore if doesn't exist
  }

  const batchId = await simulateCrash();
  await recoverAndComplete(batchId);
}

main().catch(console.error);
