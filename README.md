# tem

A lightweight, embeddable task execution engine for IO-bound workloads (LLM calls, API requests) with SQLite persistence, automatic retry, and rate limiting.

Built for **single-process, IO-bound scenarios** where you need reliable task execution without the complexity of distributed systems.

---

## Installation

```sh
bun add @qianxude/tem
```

---

## Features

- **SQLite Persistence** — Tasks survive process restarts using `bun:sqlite` with WAL mode
- **Claim-based Execution** — Atomic task claiming prevents duplicate execution, safe for concurrent async operations
- **Batch Management** — Group tasks into batches with custom `code` tags for easy identification and recovery
- **Automatic Retry** — Configurable max attempts with automatic retry for failed tasks
- **Resume & Recover** — Resume interrupted batches (crash recovery) or retry all failed tasks after fixing issues
- **Built-in Concurrency Control** — Native semaphore-based concurrency, no need for p-limit/p-queue
- **Rate Limiting** — Token bucket rate limiter for per-minute/per-second API limits (essential for LLM providers)
- **Zero External Dependencies** — No Redis, no message queues, no complex infrastructure

---

## When to Use tem

Use tem when you:

- Run IO-bound tasks (LLM calls, API requests) from a single process
- Need persistence across restarts without external databases
- Want built-in retry and rate limiting without complex setup
- Process tasks in batches and need checkpoint/resume capabilities
- Don't need multi-process clusters or DAG dependencies (yet)

Don't use tem when you need:

- Multi-process worker clusters (CPU-bound tasks)
- Complex task dependencies (DAG)
- Sub-millisecond latency requirements
- Distributed execution across machines

---

## Quick Start

```typescript
import { TEM } from "@qianxude/tem";

const tem = new TEM({
  databasePath: "./tem.db",
  concurrency: 5,
  pollIntervalMs: 1000,
  rateLimit: { requests: 60, windowMs: 60000 }  // 60 req/min
});

// Create a batch
const batch = await tem.batch.create({
  code: "2026-02-15-llm-fix",
  type: "rewrite-docs"
});

// Create tasks
await tem.task.createMany([
  { batchId: batch.id, type: "rewrite", payload: { docId: 1 } },
  { batchId: batch.id, type: "rewrite", payload: { docId: 2 } },
  { batchId: batch.id, type: "rewrite", payload: { docId: 3 } }
]);

// Register handler — payload is your task data, context has metadata
tem.worker.register("rewrite", async (payload, context) => {
  const result = await callLLM(payload);
  return result;  // Stored in task.result
});

// Start processing
tem.worker.start();

// Stop when done
await tem.stop();
```

---

## Task Lifecycle

```
pending
   ↓ claim (atomic)
running
   ↓ success
completed

running
   ↓ error + attempt < max_attempt
pending (auto-retry)

running
   ↓ error + attempt >= max_attempt
failed
```

---

## Core Concepts

- **Batch** — A named group of tasks. All recovery operations (resume, retry) work at batch level.
- **Task** — A unit of work with a `type`, opaque `payload`, and tracked `status`.
- **Worker** — Polls for pending tasks and dispatches them to registered handlers by type.
- **Payload** — Opaque JSON; the framework never parses it. Your handler receives it as-is.
- **Claim model** — Tasks are acquired atomically (`UPDATE ... WHERE status='pending'`), preventing duplicate execution.

---

## Error Handling

By default, any thrown error causes the task to retry up to `defaultMaxAttempts`:

```typescript
tem.worker.register("process", async (payload, context) => {
  console.log(`Attempt ${context.attempt}`);
  const result = await callAPI(payload);  // throws → auto-retry
  return result;
});
```

For permanent failures that should not be retried, throw `NonRetryableError`:

```typescript
import { TEM, NonRetryableError } from "@qianxude/tem";

tem.worker.register("validate", async (payload) => {
  if (!payload.id) {
    throw new NonRetryableError("Missing required field: id");
    // Task goes directly to 'failed', no retries
  }
  return process(payload);
});
```

---

## Batch Interruption

Automatically stop a batch when error thresholds are exceeded:

```typescript
const batch = await tem.batch.create({
  code: "llm-run-01",
  type: "summarize",
  interruptionCriteria: {
    maxErrorRate: 0.3,          // Stop if >30% tasks fail
    maxFailedTasks: 10,         // Stop if >10 tasks fail
    maxConsecutiveFailures: 5,  // Stop if 5 failures in a row
  }
});
```

Check interruption details after the batch stops:

```typescript
const logs = await tem.interruption.getInterruptionLog(batchId);
// [{ reason, message, statsAtInterruption }]
```

Manually interrupt a running batch:

```typescript
await tem.interruptBatch(batchId, "manual", "Stopping due to bad data");
```

---

## Auto-Detect Constraints

Probe an API endpoint to discover its concurrency and rate limits before running tasks:

```typescript
const config = await TEM.detectConstraints({
  url: "https://api.example.com/v1/endpoint",
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.API_KEY },
  body: { /* minimal valid request */ },
  timeoutMs: 30000,
  maxConcurrencyToTest: 50,
  rateLimitTestDurationMs: 10000,
});

const tem = new TEM({
  databasePath: "./tasks.db",
  concurrency: config.concurrency,
  rateLimit: config.rateLimit,
});
```

---

## Recovery Patterns

### Resume After Crash

If the process crashes while tasks are `running`, resume them on restart:

```typescript
// Reset all 'running' tasks back to 'pending'
await tem.batch.resume(batchId);
tem.worker.start();  // Continue processing
```

### Retry Failed Tasks

After fixing the root cause (e.g., API key issue), retry all failed tasks:

```typescript
// Reset failed tasks to pending, attempt counter reset to 0
await tem.batch.retryFailed(batchId);
tem.worker.start();
```

---

## Architecture

```
TEM
├── DatabaseLayer      # bun:sqlite with WAL mode
├── BatchService       # Batch CRUD + recovery
├── TaskService        # Task enqueue + claim + state updates
├── Worker             # Execution loop with concurrency/rate limiting
├── ConcurrencyController  # Semaphore for local concurrency
├── RateLimiter        # Token bucket for API rate limits
└── BatchInterruptionService  # Auto-stop on error thresholds
```

### Why Claim-Based?

Instead of:
```typescript
// WRONG: Race conditions in concurrent scenarios
const task = await db.query("SELECT * FROM task WHERE status='pending'");
await db.run("UPDATE task SET status='running' WHERE id=?", task.id);
```

tem uses atomic claim:
```typescript
// CORRECT: Atomic state transition with optimistic locking
UPDATE task
SET status='running', claimed_at=?, version=version+1
WHERE id=? AND status='pending' AND version=?
```

This ensures:
- No duplicate execution even with concurrent async operations
- Safe for future multi-worker extensions
- Clear ownership of running tasks

---

## Database Schema

### batch

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| code | TEXT | User-provided batch tag (e.g., "2026-02-15-run") |
| type | TEXT | Batch type for categorization |
| created_at | INTEGER | Timestamp |
| completed_at | INTEGER | Timestamp when all tasks done |
| metadata | TEXT | JSON metadata |

### task

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| batch_id | TEXT FK | Parent batch |
| type | TEXT | Task type for handler routing |
| status | TEXT | pending/running/completed/failed |
| payload | TEXT | JSON input data (opaque to framework) |
| result | TEXT | JSON output from handler |
| error | TEXT | Error message on failure |
| attempt | INTEGER | Current attempt count |
| max_attempt | INTEGER | Max retry attempts |
| claimed_at | INTEGER | When task was claimed |
| completed_at | INTEGER | When task finished |
| version | INTEGER | Optimistic lock version |
| created_at | INTEGER | Timestamp |

---

## API Reference

### TEM Configuration

```typescript
interface TEMConfig {
  databasePath: string;       // SQLite file path
  concurrency?: number;       // Default: 5
  pollIntervalMs?: number;    // Default: 1000ms
  defaultMaxAttempts?: number; // Default: 3
  rateLimit?: {
    requests: number;         // Number of requests
    windowMs: number;         // Time window in ms (e.g. 60000 for per-minute)
  };
}
```

### Batch Operations

```typescript
// Create batch
const batch = await tem.batch.create({
  code: "unique-batch-code",
  type: "batch-type",
  metadata?: { ... },
  interruptionCriteria?: {
    maxErrorRate?: number;
    maxFailedTasks?: number;
    maxConsecutiveFailures?: number;
  }
});

// Get batch by ID
const batch = await tem.batch.getById(batchId);

// Get statistics
const stats = await tem.batch.getStats(batchId);
// { pending, running, completed, failed, total }

// Resume after crash (running → pending)
await tem.batch.resume(batchId);

// Retry all failed (failed → pending, attempt reset)
await tem.batch.retryFailed(batchId);
```

### Task Operations

```typescript
// Create single task
await tem.task.create({
  batchId: string,
  type: string,
  payload: object,
  maxAttempts?: number
});

// Bulk create (single transaction)
await tem.task.createMany([
  { batchId, type, payload },
  ...
]);

// Get task by ID
const task = await tem.task.getById(taskId);
```

### Worker

```typescript
// Register handler
// payload: your task data; context: { taskId, batchId, attempt }
tem.worker.register("task-type", async (payload, context) => {
  const result = await doWork(payload);
  return result;  // JSON-serialized to task.result
});

// Control execution
tem.worker.start();
await tem.stop();  // Stops worker and closes DB
```

### NonRetryableError

```typescript
import { NonRetryableError } from "@qianxude/tem";

throw new NonRetryableError("reason");
// Task goes to 'failed' immediately, skipping remaining attempts
```

---

## Design Principles

1. **Single Process First** — No multi-process complexity until you actually need it
2. **Database as Source of Truth** — SQLite with WAL mode, atomic updates only
3. **Claim Model** — Never assume you own a task until you atomically claim it
4. **Opaque Payload** — Framework doesn't parse payload; handlers decide business logic
5. **Batch as Unit** — All operations (resume, retry) work at batch level for convenience

---

## Roadmap

- [x] Core execution engine
- [x] SQLite persistence
- [x] Claim-based task acquisition
- [x] Concurrency control
- [x] Rate limiting
- [x] Retry mechanism
- [x] Batch resume/retry
- [ ] Priority queue
- [ ] Delayed/scheduled tasks
- [ ] Task timeout handling
- [ ] Metrics and observability
- [ ] Multi-process worker cluster (future)

---

## License

MIT
