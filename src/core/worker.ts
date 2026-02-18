import * as i from '../interfaces/index.js';
import { TaskService, BatchInterruptionService } from '../services/index.js';
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
  /** Specific batch ID to process (optional - if set, only processes this batch) */
  batchId?: string;
  /** Interruption service for checking batch status */
  interruptionService?: BatchInterruptionService;
}

export class Worker {
  private handlers = new Map<string, i.TaskHandler>();
  private concurrency: ConcurrencyController;
  private rateLimiter?: RateLimiter;
  private running = false;
  private pollIntervalMs: number;
  private abortController: AbortController;
  private inFlightTasks: Set<Promise<void>> = new Set();
  private batchId?: string;
  private interruptionService?: BatchInterruptionService;

  // Track failure context for interruption decisions
  private consecutiveFailures = 0;
  private rateLimitHits = 0;
  private concurrencyErrors = 0;

  constructor(
    private taskService: TaskService,
    config: WorkerConfig
  ) {
    this.concurrency = new ConcurrencyController(config.concurrency);
    this.pollIntervalMs = config.pollIntervalMs;
    this.abortController = new AbortController();
    this.batchId = config.batchId;
    this.interruptionService = config.interruptionService;

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

        // For batch-specific workers: check batch is still active
        if (this.batchId && this.interruptionService) {
          const isActive = await this.interruptionService.isBatchActive(this.batchId);
          if (!isActive) {
            this.concurrency.release();
            this.stop();
            break;
          }
        }

        // Claim a task while holding the concurrency slot
        const task = await this.taskService.claim(this.batchId);

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
    const taskStartTime = Date.now();

    try {
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      const handler = this.handlers.get(task.type);
      if (!handler) {
        throw new NonRetryableError(`No handler registered for type: ${task.type}`);
      }

      const payload = JSON.parse(task.payload);

      // Build context with optional deadline
      const context: i.TaskContext = {
        taskId: task.id,
        batchId: task.batchId,
        attempt: task.attempt,
        signal: this.abortController.signal,
      };

      // If we have interruption service and batchId, set deadline from criteria
      if (this.interruptionService && task.batchId) {
        const { criteria } = await this.interruptionService['batchService'].getWithCriteria(task.batchId);
        if (criteria?.taskTimeoutMs) {
          context.deadline = new Date(taskStartTime + criteria.taskTimeoutMs);
        }
      }

      const result = await handler(payload, context);
      await this.taskService.complete(task.id, result);

      // Reset consecutive failures on success
      this.consecutiveFailures = 0;
    } catch (error) {
      const taskRuntimeMs = Date.now() - taskStartTime;
      await this.handleError(task, error, taskRuntimeMs);
    } finally {
      this.concurrency.release();
    }
  }

  /**
   * Handle task execution errors.
   */
  private async handleError(task: i.Task, error: unknown, taskRuntimeMs?: number): Promise<void> {
    const isRetryable = !(error instanceof NonRetryableError);
    const shouldRetry = isRetryable && task.attempt < task.maxAttempt;

    // Track failure type for interruption decisions
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (this.isRateLimitError(errorMessage)) {
      this.rateLimitHits++;
    } else if (this.isConcurrencyError(errorMessage)) {
      this.concurrencyErrors++;
    }

    if (shouldRetry) {
      // Reset to pending for automatic retry (attempt already incremented by claim)
      await this.taskService.retry(task.id);
      this.consecutiveFailures++;
    } else {
      await this.taskService.fail(task.id, errorMessage);
      this.consecutiveFailures++;

      // Check if batch should be interrupted
      if (task.batchId && this.interruptionService) {
        const interrupted = await this.interruptionService.checkAndInterruptIfNeeded(
          task.batchId,
          {
            consecutiveFailures: this.consecutiveFailures,
            rateLimitHits: this.rateLimitHits,
            concurrencyErrors: this.concurrencyErrors,
            currentTaskRuntimeMs: taskRuntimeMs,
          }
        );
        if (interrupted) {
          this.stop();
        }
      }
    }
  }

  private isRateLimitError(message: string): boolean {
    return message.includes('429') || message.toLowerCase().includes('rate limit');
  }

  private isConcurrencyError(message: string): boolean {
    return message.includes('502') || message.includes('503') || message.toLowerCase().includes('bad gateway') || message.toLowerCase().includes('service unavailable');
  }
}
