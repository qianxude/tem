/**
 * Simple semaphore implementation to control max concurrent tasks.
 */
export class ConcurrencyController {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(private max: number) {
    this.available = max;
  }

  /**
   * Acquire a slot. Returns a promise that resolves when a slot is available.
   */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a slot, allowing the next waiting acquirer to proceed.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  /**
   * Get the number of currently running (acquired) slots.
   */
  getRunning(): number {
    return this.max - this.available - this.queue.length;
  }
}
