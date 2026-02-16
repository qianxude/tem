import * as i from '../interfaces/index.js';
import { TaskService } from '../services/task.js';
import { ConcurrencyController, RateLimiter, type RateLimitConfig } from '../utils/index.js';

/**
 * Error class to mark errors as non-retryable.
 * When thrown from a task handler, the task will fail immediately
 * without retry attempts.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  rateLimit?: RateLimitConfig;
}

export class Worker {
  private handlers = new Map<string, i.TaskHandler>();
  private concurrency: ConcurrencyController;
  private rateLimiter?: RateLimiter;
  private running = false;
  private pollIntervalMs: number;
  private abortController: AbortController;
  private inFlightTasks: Set<Promise<void>> = new Set();

  constructor(
    private taskService: TaskService,
    config: WorkerConfig
  ) {
    this.concurrency = new ConcurrencyController(config.concurrency);
    this.pollIntervalMs = config.pollIntervalMs;
    this.abortController = new AbortController();

    if (config.rateLimit) {
      this.rateLimiter = new RateLimiter(config.rateLimit);
    }
  }

  /**
   * Register a handler for a specific task type.
   */
  register<TInput = unknown, TOutput = unknown>(
    type: string,
    handler: i.TaskHandler<TInput, TOutput>
  ): void {
    this.handlers.set(type, handler as i.TaskHandler);
  }

  /**
   * Start the worker. Begins polling for and executing tasks.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.abortController = new AbortController();
    this.runLoop();
  }

  /**
   * Stop the worker. Waits for in-flight tasks to complete.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.abortController.abort();

    // Wait for all in-flight tasks to complete
    if (this.inFlightTasks.size > 0) {
      await Promise.all(this.inFlightTasks);
    }
  }

  /**
   * Main execution loop.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      // Acquire a slot first (may wait if at concurrency limit)
      await this.concurrency.acquire();

      try {
        // Check if we're still running after acquiring
        if (!this.running) {
          this.concurrency.release();
          break;
        }

        // Claim a task while holding the concurrency slot
        const task = await this.taskService.claim();

        if (!task) {
          // No task available, release the slot and sleep
          this.concurrency.release();
          if (this.running) {
            await Bun.sleep(this.pollIntervalMs);
          }
          continue;
        }

        // Execute task without awaiting to allow parallel execution
        const taskPromise = this.execute(task);
        this.inFlightTasks.add(taskPromise);
        taskPromise.then(() => {
          this.inFlightTasks.delete(taskPromise);
        });
      } catch {
        // Release slot on error and continue
        this.concurrency.release();
      }
    }
  }

  /**
   * Execute a single task.
   * Note: Assumes concurrency slot has already been acquired.
   */
  private async execute(task: i.Task): Promise<void> {
    try {
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      const handler = this.handlers.get(task.type);
      if (!handler) {
        throw new NonRetryableError(`No handler registered for type: ${task.type}`);
      }

      const payload = JSON.parse(task.payload);
      const context: i.TaskContext = {
        taskId: task.id,
        batchId: task.batchId,
        attempt: task.attempt,
        signal: this.abortController.signal,
      };

      const result = await handler(payload, context);
      await this.taskService.complete(task.id, result);
    } catch (error) {
      await this.handleError(task, error);
    } finally {
      this.concurrency.release();
    }
  }

  /**
   * Handle task execution errors.
   */
  private async handleError(task: i.Task, error: unknown): Promise<void> {
    const isRetryable = !(error instanceof NonRetryableError);
    const shouldRetry = isRetryable && task.attempt < task.maxAttempt;

    if (shouldRetry) {
      // Reset to pending for automatic retry (attempt already incremented by claim)
      await this.taskService.retry(task.id);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskService.fail(task.id, message);
    }
  }
}
