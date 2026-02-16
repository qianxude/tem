// Public API types for TEM
// Import as: import * as i from './interfaces'

// ============================================================================
// Enums
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

// ============================================================================
// Entity Types
// ============================================================================

export interface Batch {
  id: string;
  code: string;
  type: string;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface BatchStats {
  batchId: string;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface Task {
  id: string;
  batchId: string | null;
  type: string;
  status: TaskStatus;
  payload: string; // JSON string - opaque to framework
  result: string | null; // JSON string - opaque to framework
  error: string | null;
  attempt: number;
  maxAttempt: number;
  claimedAt: Date | null;
  completedAt: Date | null;
  version: number;
  createdAt: Date;
}

// ============================================================================
// Configuration
// ============================================================================

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

// ============================================================================
// Task Handler
// ============================================================================

export type TaskHandler<TInput = unknown, TOutput = unknown> = (
  payload: TInput,
  context: TaskContext
) => Promise<TOutput>;

export interface TaskContext {
  taskId: string;
  batchId: string | null;
  attempt: number;
  signal: AbortSignal;
}

// ============================================================================
// Error Types
// ============================================================================

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

// ============================================================================
// Service Interfaces
// ============================================================================

export interface CreateBatchInput {
  code: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  batchId?: string;
  type: string;
  payload: unknown;
  maxAttempt?: number;
}

export interface BatchService {
  create(input: CreateBatchInput): Promise<Batch>;
  getById(id: string): Promise<Batch | null>;
  getByCode(code: string): Promise<Batch | null>;
  list(filter?: { type?: string }): Promise<Batch[]>;
  getStats(id: string): Promise<BatchStats>;
  complete(id: string): Promise<void>;
  resume(id: string): Promise<number>;
  retryFailed(id: string): Promise<number>;
}

export interface TaskService {
  create(input: CreateTaskInput): Promise<Task>;
  createMany(inputs: CreateTaskInput[]): Promise<Task[]>;
  getById(id: string): Promise<Task | null>;
  claim(batchId?: string): Promise<Task | null>;
  complete(id: string, result: unknown): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  retry(id: string): Promise<void>;
}

// ============================================================================
// Database
// ============================================================================

export interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}
