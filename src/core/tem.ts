import { Database, type DatabaseOptions } from '../database/index.js';
import { BatchService, TaskService, BatchInterruptionService } from '../services/index.js';
import { Worker, type WorkerConfig } from './worker.js';
import {
  detectConstraints,
  type DetectOptions,
  type DetectedConfig,
} from '../utils/auto-detect.js';

export type { DetectOptions, DetectedConfig };

export interface TEMConfig {
  // Database
  databasePath: string;

  // Concurrency
  concurrency: number;

  // Rate limiting
  rateLimit?: {
    requests: number;
    windowMs: number;
  };

  // Retry
  defaultMaxAttempts: number;

  // Polling
  pollIntervalMs: number;

  // Optional: Specific batch ID to process (if set, only processes this batch)
  batchId?: string;
}

export class TEM {
  readonly batch: BatchService;
  readonly task: TaskService;
  readonly worker: Worker;
  readonly interruption: BatchInterruptionService;

  private database: Database;

  /**
   * Auto-detect API constraints including maximum concurrency and rate limits.
   * Uses binary search for concurrency detection and burst testing for rate limits.
   *
   * @example
   * ```typescript
   * const config = await TEM.detectConstraints({
   *   url: 'https://api.openai.com/v1/chat/completions',
   *   method: 'POST',
   *   headers: {
   *     'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
   *     'Content-Type': 'application/json'
   *   },
   *   body: {
   *     model: 'gpt-4o-mini',
   *     messages: [{ role: 'user', content: 'Hi' }],
   *     max_tokens: 10
   *   }
   * });
   *
   * const tem = new TEM({
   *   databasePath: './tasks.db',
   *   concurrency: config.concurrency,
   *   rateLimit: config.rateLimit,
   *   defaultMaxAttempts: 3,
   *   pollIntervalMs: 100
   * });
   * ```
   */
  static async detectConstraints(options: DetectOptions): Promise<DetectedConfig> {
    return detectConstraints(options);
  }

  constructor(config: TEMConfig) {

    // Initialize database
    const dbOptions: DatabaseOptions = {
      path: config.databasePath,
    };
    this.database = new Database(dbOptions);

    // Initialize services
    this.batch = new BatchService(this.database);
    this.task = new TaskService(this.database);
    this.interruption = new BatchInterruptionService(this.database, this.batch);

    // Initialize worker with config
    const workerConfig: WorkerConfig = {
      concurrency: config.concurrency,
      pollIntervalMs: config.pollIntervalMs,
      rateLimit: config.rateLimit,
      batchId: config.batchId,
      interruptionService: this.interruption,
    };
    this.worker = new Worker(this.task, workerConfig);
  }

  /**
   * Stop the TEM engine.
   * Stops the worker and closes the database connection.
   */
  async stop(): Promise<void> {
    await this.worker.stop();
    this.database.close();
  }

  /**
   * Manually interrupt a batch with a specified reason.
   * This will stop the worker if processing this batch and prevent further tasks from being claimed.
   *
   * @param batchId - The ID of the batch to interrupt
   * @param reason - The reason for interruption (default: 'manual')
   * @param message - Optional custom message explaining the interruption
   */
  async interruptBatch(
    batchId: string,
    reason?: import('../interfaces/index.js').BatchInterruptionReason,
    message?: string
  ): Promise<void> {
    await this.interruption.interrupt(
      batchId,
      reason ?? 'manual',
      message ?? 'Batch manually interrupted'
    );
  }
}
