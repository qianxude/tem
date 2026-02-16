import { TEM } from '../src/core/tem.js';

/**
 * Basic example demonstrating task creation and processing.
 *
 * This shows:
 * - Creating a batch
 * - Creating tasks
 * - Registering task handlers
 * - Starting the worker
 * - Monitoring progress
 */

async function main() {
  // Initialize TEM
  const tem = new TEM({
    databasePath: './basic-example.db',
    concurrency: 3,
    defaultMaxAttempts: 3,
    pollIntervalMs: 100,
  });

  console.log('TEM initialized');

  try {
    // Create a batch
    const batch = await tem.batch.create({
      code: 'BASIC-DEMO',
      type: 'demo',
      metadata: { description: 'Basic example batch' },
    });
    console.log(`Created batch: ${batch.code} (${batch.id})`);

    // Create some tasks
    const tasks = await tem.task.createMany([
      { batchId: batch.id, type: 'greet', payload: { name: 'Alice', language: 'en' } },
      { batchId: batch.id, type: 'greet', payload: { name: 'Bob', language: 'es' } },
      { batchId: batch.id, type: 'greet', payload: { name: 'Carol', language: 'fr' } },
      { batchId: batch.id, type: 'calculate', payload: { operation: 'add', a: 10, b: 20 } },
      { batchId: batch.id, type: 'calculate', payload: { operation: 'multiply', a: 5, b: 6 } },
    ]);
    console.log(`Created ${tasks.length} tasks`);

    // Register handlers
    tem.worker.register('greet', async (payload: { name: string; language: string }) => {
      const greetings: Record<string, string> = {
        en: 'Hello',
        es: 'Hola',
        fr: 'Bonjour',
      };
      const greeting = greetings[payload.language] ?? 'Hi';
      const message = `${greeting}, ${payload.name}!`;
      console.log(`  [greet] ${message}`);
      return { message };
    });

    tem.worker.register(
      'calculate',
      async (payload: { operation: string; a: number; b: number }) => {
        let result: number;
        switch (payload.operation) {
          case 'add':
            result = payload.a + payload.b;
            break;
          case 'multiply':
            result = payload.a * payload.b;
            break;
          default:
            throw new Error(`Unknown operation: ${payload.operation}`);
        }
        console.log(`  [calculate] ${payload.a} ${payload.operation} ${payload.b} = ${result}`);
        return { result };
      }
    );

    // Start the worker
    console.log('\nStarting worker...');
    tem.worker.start();

    // Monitor progress
    while (true) {
      const stats = await tem.batch.getStats(batch.id);
      console.log(
        `Progress: ${stats.completed}/${stats.total} completed, ${stats.failed} failed`
      );

      if (stats.completed + stats.failed === stats.total) {
        break;
      }

      await Bun.sleep(200);
    }

    // Show final stats
    const finalStats = await tem.batch.getStats(batch.id);
    console.log('\n=== Final Results ===');
    console.log(`Total tasks: ${finalStats.total}`);
    console.log(`Completed: ${finalStats.completed}`);
    console.log(`Failed: ${finalStats.failed}`);

    // Show some results
    const firstTask = await tem.task.getById(tasks[0].id);
    console.log(`\nSample result: ${firstTask?.result}`);
  } finally {
    // Cleanup
    await tem.stop();
    console.log('\nTEM stopped');
  }
}

main().catch(console.error);
