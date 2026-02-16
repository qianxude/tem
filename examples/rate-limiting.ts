import { TEM } from '../src/core/tem.js';

/**
 * Rate Limiting Example
 *
 * This demonstrates:
 * 1. Configuring rate limits
 * 2. Processing tasks with API-like delays
 * 3. Observing throttle behavior
 */

async function main() {
  // Configure TEM with rate limiting
  // This limits to 5 requests per second
  const tem = new TEM({
    databasePath: './rate-limiting-example.db',
    concurrency: 10, // High concurrency, but rate limited
    defaultMaxAttempts: 3,
    pollIntervalMs: 50,
    rateLimit: {
      requests: 5,
      windowMs: 1000, // 5 requests per second
    },
  });

  try {
    console.log('=== Rate Limiting Demo ===');
    console.log('Configuration: 5 requests per second\n');

    // Create batch
    const batch = await tem.batch.create({
      code: 'RATE-LIMIT-DEMO',
      type: 'api-calls',
    });

    // Create 20 tasks
    const taskCount = 20;
    await tem.task.createMany(
      Array.from({ length: taskCount }, (_, i) => ({
        batchId: batch.id,
        type: 'api-call',
        payload: { index: i + 1, endpoint: `/api/items/${i + 1}` },
      }))
    );

    console.log(`Created ${taskCount} tasks\n`);

    // Track execution times
    const timestamps: number[] = [];

    tem.worker.register(
      'api-call',
      async (payload: { index: number; endpoint: string }) => {
        const timestamp = Date.now();
        timestamps.push(timestamp);

        // Simulate API work
        await Bun.sleep(50);

        const relativeTime = timestamp - timestamps[0];
        console.log(
          `  [${payload.index.toString().padStart(2)}] ${relativeTime.toString().padStart(5)}ms - ${payload.endpoint}`
        );

        return { status: 200, data: { id: payload.index } };
      }
    );

    // Start processing
    console.log('Starting worker (observe the spacing between requests)...\n');
    const startTime = Date.now();
    tem.worker.start();

    // Monitor progress
    let lastCompleted = 0;
    while (true) {
      const stats = await tem.batch.getStats(batch.id);

      if (stats.completed > lastCompleted) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.completed / elapsed;
        console.log(
          `\nProgress: ${stats.completed}/${stats.total} completed (${rate.toFixed(2)} req/sec avg)`
        );
        lastCompleted = stats.completed;
      }

      if (stats.completed === stats.total) {
        break;
      }

      await Bun.sleep(50);
    }

    const totalTime = Date.now() - startTime;

    // Analysis
    console.log('\n=== Rate Analysis ===');
    console.log(`Total time: ${totalTime}ms`);
    console.log(`Tasks completed: ${timestamps.length}`);

    // Calculate gaps between requests
    const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);

    console.log(`\nGap between requests:`);
    console.log(`  Average: ${avgGap.toFixed(2)}ms`);
    console.log(`  Min: ${minGap}ms`);
    console.log(`  Max: ${maxGap}ms`);

    // Expected vs actual rate
    const actualRate = timestamps.length / (totalTime / 1000);
    const configuredRate = 5; // per second

    console.log(`\nRate comparison:`);
    console.log(`  Configured: ${configuredRate} req/sec`);
    console.log(`  Actual: ${actualRate.toFixed(2)} req/sec`);

    // Show burst vs throttled
    console.log(`\nBurst analysis (first 5 requests should be quick):`);
    const burstGaps = gaps.slice(0, 4);
    const throttledGaps = gaps.slice(5);
    const avgThrottledGap =
      throttledGaps.reduce((a, b) => a + b, 0) / throttledGaps.length || 0;

    console.log(`  Burst gaps (avg): ${(burstGaps.reduce((a, b) => a + b, 0) / burstGaps.length).toFixed(2)}ms`);
    console.log(`  Throttled gaps (avg): ${avgThrottledGap.toFixed(2)}ms`);

    console.log('\n=== Summary ===');
    console.log('The rate limiter allows an initial burst up to the bucket size,');
    console.log('then spaces out subsequent requests to maintain the configured rate.');
  } finally {
    await tem.stop();
    console.log('\nTEM stopped');
  }
}

main().catch(console.error);
