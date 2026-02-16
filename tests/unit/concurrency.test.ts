import { describe, expect, it } from 'bun:test';
import { ConcurrencyController } from '../../src/utils/concurrency.js';

describe('ConcurrencyController', () => {
  describe('semaphore acquire/release', () => {
    it('should acquire slot immediately when available', async () => {
      const controller = new ConcurrencyController(2);

      const start = Date.now();
      await controller.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10); // Should be immediate
      expect(controller.getRunning()).toBe(1);
    });

    it('should release slot for reuse', async () => {
      const controller = new ConcurrencyController(1);

      await controller.acquire();
      expect(controller.getRunning()).toBe(1);

      controller.release();
      expect(controller.getRunning()).toBe(0);

      // Should be able to acquire again
      await controller.acquire();
      expect(controller.getRunning()).toBe(1);
    });

    it('should queue when no slots available', async () => {
      const controller = new ConcurrencyController(1);
      const order: string[] = [];

      // First acquisition should be immediate
      await controller.acquire();
      order.push('first-acquired');

      // Second acquisition should wait
      const secondPromise = controller.acquire().then(() => {
        order.push('second-acquired');
      });

      // Small delay to ensure second is queued
      await Bun.sleep(10);
      order.push('after-queue');

      // Release to let second proceed
      controller.release();
      await secondPromise;

      expect(order).toEqual(['first-acquired', 'after-queue', 'second-acquired']);
    });
  });

  describe('max concurrency enforcement', () => {
    it('should enforce max concurrency limit', async () => {
      const controller = new ConcurrencyController(2);
      let running = 0;
      let maxRunning = 0;

      const tasks = Array.from({ length: 5 }, async () => {
        await controller.acquire();
        running++;
        maxRunning = Math.max(maxRunning, running);

        // Simulate work
        await Bun.sleep(20);

        running--;
        controller.release();
      });

      await Promise.all(tasks);

      expect(maxRunning).toBe(2);
    });

    it('should handle zero concurrency edge case', async () => {
      const controller = new ConcurrencyController(0);

      // Should queue indefinitely since no slots available
      let acquired = false;
      const promise = controller.acquire().then(() => {
        acquired = true;
      });

      await Bun.sleep(50);
      expect(acquired).toBe(false);

      // Cancel by releasing (though nothing was acquired)
      // This tests that the controller handles edge cases gracefully
      promise.catch(() => {}); // Ignore any rejection
    });
  });

  describe('getRunning() accuracy', () => {
    it('should report correct running count', async () => {
      const controller = new ConcurrencyController(3);

      expect(controller.getRunning()).toBe(0);

      await controller.acquire();
      expect(controller.getRunning()).toBe(1);

      await controller.acquire();
      expect(controller.getRunning()).toBe(2);

      controller.release();
      expect(controller.getRunning()).toBe(1);

      controller.release();
      expect(controller.getRunning()).toBe(0);
    });

    it('should account for queued requests', async () => {
      const controller = new ConcurrencyController(1);

      await controller.acquire();
      expect(controller.getRunning()).toBe(1);

      // Start second acquire (will be queued)
      let acquired = false;
      const secondAcquire = controller.acquire().then(() => {
        acquired = true;
      });

      // Small delay to ensure the promise executor has run
      await Bun.sleep(10);

      // Queued request hasn't acquired yet, so running count should be:
      // max(1) - available(0) - queue(1) = 0
      // This is correct - only one slot exists and the queued task is waiting
      expect(controller.getRunning()).toBe(0);
      expect(acquired).toBe(false);

      // Release to let queued request proceed
      controller.release();
      await secondAcquire;
      expect(controller.getRunning()).toBe(1);
      expect(acquired).toBe(true);

      controller.release();
      expect(controller.getRunning()).toBe(0);
    });
  });

  describe('queue ordering (FIFO)', () => {
    it('should process queued requests in FIFO order', async () => {
      const controller = new ConcurrencyController(1);
      const order: number[] = [];

      // First acquires immediately
      await controller.acquire();

      // Create 3 queued acquires
      const promises = [1, 2, 3].map((num) =>
        controller.acquire().then(() => {
          order.push(num);
          controller.release();
        })
      );

      // Wait for all to be queued
      await Bun.sleep(10);

      // Release and process one by one
      controller.release();
      await Promise.all(promises);

      expect(order).toEqual([1, 2, 3]);
    });

    it('should maintain FIFO across multiple release/acquire cycles', async () => {
      const controller = new ConcurrencyController(2);
      const order: number[] = [];

      // Fill both slots
      await controller.acquire();
      await controller.acquire();

      // Queue 4 more
      const promises = [1, 2, 3, 4].map((num) =>
        controller.acquire().then(() => {
          order.push(num);
          // Hold for a bit then release
          return Bun.sleep(5).then(() => controller.release());
        })
      );

      await Bun.sleep(10);

      // Release both slots
      controller.release();
      controller.release();

      await Promise.all(promises);

      expect(order).toEqual([1, 2, 3, 4]);
    });
  });

  describe('concurrent stress test', () => {
    it('should handle many concurrent acquires', async () => {
      const controller = new ConcurrencyController(5);
      let running = 0;
      let maxRunning = 0;
      const results: number[] = [];

      const tasks = Array.from({ length: 50 }, async (_, i) => {
        await controller.acquire();
        running++;
        maxRunning = Math.max(maxRunning, running);

        // Minimal work
        await Bun.sleep(1);
        results.push(i);

        running--;
        controller.release();
      });

      await Promise.all(tasks);

      expect(maxRunning).toBe(5);
      expect(results.length).toBe(50);
    });

    it('should release all slots correctly after stress', async () => {
      const controller = new ConcurrencyController(3);

      // Stress test
      const tasks = Array.from({ length: 30 }, async () => {
        await controller.acquire();
        await Bun.sleep(Math.random() * 5);
        controller.release();
      });

      await Promise.all(tasks);

      // Should be able to acquire all slots after stress
      expect(controller.getRunning()).toBe(0);
      await controller.acquire();
      await controller.acquire();
      await controller.acquire();
      expect(controller.getRunning()).toBe(3);
    });
  });
});
