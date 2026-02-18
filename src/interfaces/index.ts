// Public API types for TEM
// Import as: import * as i from './interfaces'

// ============================================================================
// Enums
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type BatchStatus = 'active' | 'interrupted' | 'completed';

export type BatchInterruptionReason =
  | 'error_rate_exceeded'
  | 'failed_tasks_exceeded'
  | 'consecutive_failures_exceeded'
  | 'rate_limit_hits_exceeded'
  | 'concurrency_errors_exceeded'
  | 'task_timeout'
  | 'batch_runtime_exceeded'
  | 'manual';

// ============================================================================
// Entity Types
// ============================================================================

export interface BatchInterruptionCriteria {
  /** Max error rate (0-1, e.g., 0.1 = 10%) */
  maxErrorRate?: number;
  /** Max absolute number of failed tasks */
  maxFailedTasks?: number;
  /** Max consecutive failures before interruption */
  maxConsecutiveFailures?: number;
  /** Max rate limit (429) hits before interruption */
  maxRateLimitHits?: number;
  /** Max concurrency errors (502/503) before interruption - indicates too aggressive concurrency */
  maxConcurrencyErrors?: number;
  /** Max runtime for a single task in ms */
  taskTimeoutMs?: number;
  /** Max total batch runtime in ms */
  maxBatchRuntimeMs?: number;
}

export interface Batch {
  id: string;
  code: string;
  type: string;
  status: BatchStatus;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown> | null;
  interruptionCriteria: BatchInterruptionCriteria | null;
}

export interface BatchStats {
  batchId: string;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface BatchInterruption {
  batchId: string;
  reason: BatchInterruptionReason;
  message: string;
  statsAtInterruption: BatchStats;
  createdAt: Date;
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
// Auto-Detect Configuration
// ============================================================================

export interface DetectOptions {
  /** Target URL to test */
  url: string;
  /** HTTP method to use (default: GET) */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request headers to include */
  headers?: Record<string, string>;
  /** Request body (will be JSON stringified for POST/PUT/PATCH) */
  body?: unknown;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Maximum concurrency level to test (default: 100) */
  maxConcurrencyToTest?: number;
  /** Duration to run rate limit tests (default: 10000) */
  rateLimitTestDurationMs?: number;
}

export interface DetectedConfig {
  /** Recommended concurrency (80% of detected max) */
  concurrency: number;
  /** Recommended rate limit (90% of detected limit) */
  rateLimit: {
    requests: number;
    windowMs: number;
  };
  /** Confidence level in the detection results */
  confidence: 'high' | 'medium' | 'low';
  /** Notes about the detection process and findings */
  notes: string[];
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
  /** Deadline for task execution (for timeout enforcement) */
  deadline?: Date;
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
  interruptionCriteria?: BatchInterruptionCriteria;
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
  updateStatus(id: string, status: BatchStatus): Promise<void>;
  getWithCriteria(id: string): Promise<{ batch: Batch; criteria: BatchInterruptionCriteria | null }>;
}

export interface BatchInterruptionService {
  checkAndInterruptIfNeeded(
    batchId: string,
    context: {
      consecutiveFailures?: number;
      rateLimitHits?: number;
      concurrencyErrors?: number;
      currentTaskRuntimeMs?: number;
    }
  ): Promise<boolean>;
  interrupt(batchId: string, reason: BatchInterruptionReason, message: string): Promise<void>;
  isBatchActive(batchId: string): Promise<boolean>;
  getInterruptionLog(batchId: string): Promise<BatchInterruption[]>;
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
