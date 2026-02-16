import { Database, type DatabaseOptions } from '../database/index.js';
import { BatchService, TaskService } from '../services/index.js';
import { Worker, type WorkerConfig } from './worker.js';

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
}

export class TEM {
  readonly batch: BatchService;
  readonly task: TaskService;
  readonly worker: Worker;

  private database: Database;

  constructor(config: TEMConfig) {
    // Initialize database
    const dbOptions: DatabaseOptions = {
      path: config.databasePath,
    };
    this.database = new Database(dbOptions);

    // Initialize services
    this.batch = new BatchService(this.database);
    this.task = new TaskService(this.database);

    // Initialize worker with config
    const workerConfig: WorkerConfig = {
      concurrency: config.concurrency,
      pollIntervalMs: config.pollIntervalMs,
      rateLimit: config.rateLimit,
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
}
