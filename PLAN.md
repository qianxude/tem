# TEM Implementation Plan

This document outlines the phased implementation of the tem (Task Execution Management) framework.

**Status**: Planning Phase
**Target**: Bun + TypeScript + bun:sqlite
**Scope**: Single-process, IO-bound task execution with persistence

---

## Phase 1: Foundation (Week 1)

### Goal
Establish the project structure, database layer, and core domain models.

### Deliverables

#### 1.1 Project Setup
- [ ] Initialize Bun project with TypeScript
- [ ] Configure `tsconfig.json` (strict mode, ESM)
- [ ] Set up directory structure:
  ```
  /src
    /core         # Core engine classes
    /services     # Batch, Task services
    /database     # SQLite abstraction
    /worker       # Execution loop
    /utils        # Rate limiter, concurrency controller
    interfaces.ts # Public API types
    index.ts      # Main exports
  /tests
  ```
- [ ] Add development scripts (typecheck, test, lint)

#### 1.2 Database Layer
- [ ] Create `Database` class wrapping `bun:sqlite`
- [ ] Implement connection with WAL mode
- [ ] Set `busy_timeout` for concurrent access safety
- [ ] Schema migration system (simple version table)
- [ ] Execute SQL with parameterized queries
- [ ] Transaction support

#### 1.3 Database Schema

**batch table:**
```sql
CREATE TABLE batch (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata TEXT
);
```

**task table:**
```sql
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempt INTEGER DEFAULT 0,
  max_attempt INTEGER DEFAULT 3,
  claimed_at INTEGER,
  completed_at INTEGER,
  version INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

**Indexes:**
```sql
CREATE INDEX idx_task_batch ON task(batch_id);
CREATE INDEX idx_task_status ON task(status);
CREATE INDEX idx_task_claimed ON task(claimed_at);
CREATE INDEX idx_batch_code ON batch(code);
```

#### 1.4 Core Types & Interfaces
- [ ] Define `Batch`, `Task` entity types
- [ ] Define `TEMConfig` interface
- [ ] Define `TaskHandler` type
- [ ] Define service interfaces (BatchService, TaskService)

### Success Criteria
- Database initializes correctly with schema
- Can connect and execute basic queries
- TypeScript compiles with strict mode

---

## Phase 2: Task Management (Week 1-2)

### Goal
Implement batch and task lifecycle management.

### Deliverables

#### 2.1 BatchService
```typescript
interface BatchService {
  create(input: { code: string; type: string; metadata?: object }): Promise<Batch>;
  get(id: string): Promise<Batch | null>;
  list(filter?: { type?: string }): Promise<Batch[]>;
  getStats(id: string): Promise<BatchStats>;
  resume(id: string): Promise<number>;      // Returns count of reset tasks
  retryFailed(id: string): Promise<number>; // Returns count of reset tasks
}
```

Implementation notes:
- `resume`: `UPDATE task SET status='pending' WHERE batch_id=? AND status='running'`
- `retryFailed`: `UPDATE task SET status='pending', attempt=0 WHERE batch_id=? AND status='failed'`
- `getStats`: Aggregate query counting by status

#### 2.2 TaskService
```typescript
interface TaskService {
  enqueue(input: TaskInput): Promise<Task>;
  enqueueMany(inputs: TaskInput[]): Promise<Task[]>;
  claimOne(batchId?: string): Promise<Task | null>;
  complete(id: string, result: unknown): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}
```

Implementation notes:
- `claimOne` must use atomic UPDATE with version check:
  ```sql
  UPDATE task
  SET status='running', claimed_at=?, version=version+1
  WHERE id=(
    SELECT id FROM task
    WHERE status='pending' AND (batch_id=? OR ? IS NULL)
    ORDER BY created_at
    LIMIT 1
  ) AND status='pending'
  RETURNING *
  ```
- `enqueueMany` uses transaction
- Generate UUIDs for task/batch IDs

#### 2.3 State Machine
Document and implement task state transitions:

```
pending ──claim──► running ──success──► completed
                          │
                          └─error──► [attempt < max] ──► pending
                                               │
                                               └─[attempt >= max] ──► failed
```

### Success Criteria
- Can create batches and enqueue tasks
- Can claim tasks atomically
- State transitions work correctly
- Batch resume/retry reset correct counts

---

## Phase 3: Execution Engine (Week 2)

### Goal
Implement the worker execution loop with concurrency and rate limiting.

### Deliverables

#### 3.1 ConcurrencyController
Simple semaphore implementation:

```typescript
class ConcurrencyController {
  constructor(private max: number);
  acquire(): Promise<void>;
  release(): void;
  getRunning(): number;
}
```

Implementation using Promise queue or atomic counter.

#### 3.2 RateLimiter
Token bucket implementation:

```typescript
interface RateLimitConfig {
  perMinute?: number;
  perSecond?: number;
}

class RateLimiter {
  constructor(config: RateLimitConfig);
  async acquire(): Promise<void>;
}
```

Algorithm:
- Track tokens and last refill timestamp
- Refill tokens based on elapsed time
- If no tokens available, sleep and retry
- Support both perMinute and perSecond simultaneously

#### 3.3 Worker

```typescript
class Worker {
  register(type: string, handler: TaskHandler): void;
  start(): void;
  stop(): Promise<void>;
}
```

Execution loop:
```typescript
while (this.running) {
  while (this.concurrency.getRunning() < this.maxConcurrency) {
    const task = await this.taskService.claimOne();
    if (!task) break;
    this.execute(task);
  }
  await sleep(this.pollInterval);
}
```

Task execution flow:
```typescript
async execute(task: Task) {
  await this.concurrency.acquire();
  try {
    await this.rateLimiter.acquire();
    const handler = this.handlers.get(task.type);
    const result = await handler(task);
    await this.taskService.complete(task.id, result);
  } catch (error) {
    await this.handleError(task, error);
  } finally {
    this.concurrency.release();
  }
}
```

Error handling:
```typescript
async handleError(task: Task, error: Error) {
  const isRetryable = this.isRetryableError(error);
  const shouldRetry = isRetryable && task.attempt < task.max_attempt;

  if (shouldRetry) {
    // Reset to pending for automatic retry
    await this.db.run(
      `UPDATE task SET status='pending', attempt=attempt+1, error=? WHERE id=?`,
      [error.message, task.id]
    );
  } else {
    await this.taskService.fail(task.id, error.message);
  }
}
```

### Success Criteria
- Worker processes tasks with configured concurrency
- Rate limiting works correctly (no bursts over limit)
- Retry mechanism respects max attempts
- Stop gracefully waits for running tasks

---

## Phase 4: Integration & Testing (Week 2-3)

### Goal
Wire everything together and validate with real-world scenarios.

### Deliverables

#### 4.1 TEM Main Class
```typescript
export class TEM {
  batch: BatchService;
  task: TaskService;
  worker: Worker;

  constructor(config: TEMConfig) {
    // Initialize database
    // Initialize services
    // Initialize worker with config
  }
}
```

#### 4.2 Test Suite

**Unit Tests:**
- [ ] Database operations
- [ ] Batch CRUD and recovery
- [ ] Task state transitions
- [ ] Claim atomicity (concurrent claims)
- [ ] Concurrency controller
- [ ] Rate limiter accuracy

**Integration Tests:**
- [ ] Full workflow: create batch → enqueue → process → complete
- [ ] Retry mechanism (inject failures)
- [ ] Crash recovery simulation
- [ ] Rate limiting accuracy over time
- [ ] Concurrent task execution safety

**Mock LLM Handler:**
```typescript
// Simulates realistic LLM workload
const mockLLMHandler = async (task) => {
  // Random delay 100-500ms
  // Random success/failure with ~20% failure rate
  // Throw 429 errors occasionally
  return { rewritten: true };
};
```

#### 4.3 Example Usage
Create `/examples` directory with:
- Basic batch processing example
- Resume after crash example
- Retry failed tasks example
- Rate limiting configuration example

### Success Criteria
- All tests pass
- Example scripts run successfully
- 1000+ tasks process correctly with various failure rates
- Resume/retry work as expected

---

## Phase 5: Polish & Documentation (Week 3)

### Goal
Prepare for release with documentation and tooling.

### Deliverables

#### 5.1 Documentation
- [ ] Complete API reference
- [ ] Usage guides for common patterns
- [ ] Architecture decision records (ADRs)
- [ ] Troubleshooting guide

#### 5.2 Tooling
- [ ] ESLint/oxlint configuration
- [ ] Type checking in CI
- [ ] Basic benchmark script (tasks/second)

#### 5.3 Error Handling
- [ ] Custom error classes
- [ ] Better error messages
- [ ] Error categorization (retryable vs fatal)

#### 5.4 Cleanup
- [ ] Remove console.log statements
- [ ] Add structured logging interface
- [ ] Final code review and refactoring

### Success Criteria
- Documentation is comprehensive
- No lint errors
- Clean, maintainable codebase

---

## Implementation Order Summary

| Phase | Component | Priority |
|-------|-----------|----------|
| 1 | Project setup, Database, Schema | Must have |
| 1 | Core types and interfaces | Must have |
| 2 | BatchService | Must have |
| 2 | TaskService (incl. claimOne) | Must have |
| 3 | ConcurrencyController | Must have |
| 3 | RateLimiter | Must have |
| 3 | Worker execution loop | Must have |
| 4 | Integration tests | Must have |
| 4 | Example usage | Must have |
| 5 | Documentation | Should have |
| 5 | Benchmarks | Nice to have |

---

## Key Design Decisions to Remember

1. **Claim Model**: Always use atomic UPDATE ... WHERE status='pending' for task acquisition
2. **Version Field**: Include in UPDATE WHERE clauses for optimistic locking
3. **No p-limit**: Native semaphore is sufficient and more controllable
4. **Opaque Payload**: Never parse payload JSON in framework code
5. **Batch Code**: Required field for user tagging, not auto-generated
6. **Single Process**: Design for single process, but keep claim model for future safety

---

## Open Questions

1. Do we need task priorities in v1? (Recommended: No)
2. Do we need delayed/scheduled tasks? (Recommended: No)
3. Do we need task timeouts? (Recommended: Yes, Phase 4)
4. Should we support multiple workers in same process? (Recommended: No, one worker with concurrency)

---

## Milestones

- **M1 (End of Phase 1)**: Database layer works, can create batches and tasks
- **M2 (End of Phase 2)**: Can claim and update task states, resume/retry work
- **M3 (End of Phase 3)**: Worker processes tasks with concurrency and rate limiting
- **M4 (End of Phase 4)**: Full test coverage, examples work
- **M5 (End of Phase 5)**: Release ready

---

*Last updated: 2026-02-16*
