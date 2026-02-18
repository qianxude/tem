# tem

A lightweight, embeddable task execution engine for IO-bound workloads (LLM calls, API requests) with SQLite persistence, automatic retry, and rate limiting.

Built for **single-process, IO-bound scenarios** where you need reliable task execution without the complexity of distributed systems.

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

// Initialize
const tem = new TEM({
  dbPath: "./tem.db",
  concurrency: 5,           // Max 5 concurrent tasks
  pollInterval: 1000,       // Check for new tasks every 1s
  rateLimit: {
    perMinute: 60,          // Respect LLM provider limits
    perSecond: 5
  }
});

// Create a batch
const batch = await tem.batch.create({
  code: "2026-02-15-llm-fix",  // Your custom tag
  type: "rewrite-docs"
});

// Enqueue tasks
await tem.task.enqueueMany([
  { batchId: batch.id, type: "rewrite", payload: { docId: 1 } },
  { batchId: batch.id, type: "rewrite", payload: { docId: 2 } },
  { batchId: batch.id, type: "rewrite", payload: { docId: 3 } }
]);

// Register handler
tem.worker.register("rewrite", async (task) => {
  const result = await callLLM(task.payload);
  return result;  // Stored in task.result
});

// Start processing
tem.worker.start();
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
└── RetryStrategy      # Configurable retry logic
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
  dbPath: string;           // SQLite file path
  concurrency?: number;     // Default: 5
  pollInterval?: number;    // Default: 1000ms
  rateLimit?: {
    perMinute?: number;
    perSecond?: number;
  };
}
```

### Batch Operations

```typescript
// Create batch
const batch = await tem.batch.create({
  code: "unique-batch-code",
  type: "batch-type",
  metadata?: { ... }
});

// Get batch info
const batch = await tem.batch.get(batchId);

// List batches
const batches = await tem.batch.list({ type?: "..." });

// Get statistics
const stats = await tem.batch.getStats(batchId);
// { pending: 5, running: 2, completed: 10, failed: 3 }

// Resume after crash (running → pending)
await tem.batch.resume(batchId);

// Retry all failed (failed → pending, attempt=0)
await tem.batch.retryFailed(batchId);
```

### Task Operations

```typescript
// Enqueue single task
await tem.task.enqueue({
  batchId: string,
  type: string,
  payload: object,
  maxAttempt?: number  // Default: 3
});

// Bulk enqueue (transaction)
await tem.task.enqueueMany([
  { batchId, type, payload },
  ...
]);
```

### Worker

```typescript
// Register handler
tem.worker.register("task-type", async (task) => {
  // task.id, task.batchId, task.payload, task.attempt
  const result = await doWork(task.payload);
  return result;  // Will be JSON-serialized to task.result
});

// Control execution
tem.worker.start();
await tem.worker.stop();
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
