# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product Overview

tem — A lightweight task execution engine for IO-bound workloads (LLM, APIs) with SQLite persistence, retry, and rate limiting.

Built for **single-process, IO-bound scenarios** where you need reliable task execution without the complexity of distributed systems.

### Development Context

The team speaks and writes in both English and Chinese. Tasks and code may be in either language.

## Technology Stack

- **Runtime:** Bun.js
- **Language:** TypeScript (strict mode, ESM)
- **Database:** SQLite via `bun:sqlite` with WAL mode
- **Linting:** oxlint / oxfmt (chosen for speed)

## Development Workflow

```sh
# Typecheck (fast)
bun run typecheck

# Run tests
bun run test -- -t "test name"      # Single suite by name
bun run test -- "glob"              # Specific files by glob

# Lint
bun run lint:file -- "file1.ts"     # Specific files
bun run lint                         # All files
```

## Project Structure

```
/src
  /core              # Core engine classes (TEM, Worker)
  /services          # BatchService, TaskService
  /database          # SQLite abstraction, schema, migrations
  /utils             # RateLimiter, ConcurrencyController
  /interfaces        # Public API types (import as namespace)
  index.ts           # Main exports
/tests
  /unit              # Unit tests
  /integration       # Integration tests
/examples            # Usage examples
```

## Module Import Conventions

- **Extensionless Imports**: Always use extensionless paths for local module imports (e.g., `import { tool } from "./utils"` not `./utils.ts`).
- **Interface Imports**: Import interfaces as namespace aliases: `import * as i from './interfaces'`, then use `i.SomeInterface`. Never import interfaces directly like `import { SomeInterface } from '../interfaces'`.

## Package Management

**Use `bun` as the package manager.** This project uses Bun.js as its runtime, so prefer `bun install` over `npm install` when adding dependencies.

```bash
# Install dependencies
bun install

# Add a new dependency
bun add <package>

# Add a dev dependency
bun add -d <package>
```

## Architecture Notes

### Claim-Based Task Execution

The framework uses atomic claim for task acquisition instead of SELECT then UPDATE:

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

This ensures no duplicate execution even with concurrent async operations.

### Task State Machine

```
pending ──claim──► running ──success──► completed
                          │
                          └─error──► [attempt < max] ──► pending
                                               │
                                               └─[attempt >= max] ──► failed
```

### Key Design Decisions

1. **Claim Model**: Always use atomic UPDATE ... WHERE status='pending' for task acquisition
2. **Version Field**: Include in UPDATE WHERE clauses for optimistic locking
3. **No p-limit**: Native semaphore is sufficient and more controllable
4. **Opaque Payload**: Never parse payload JSON in framework code (business logic only)
5. **Batch Code**: Required field for user tagging, not auto-generated
6. **Single Process**: Design for single process, but keep claim model for future safety

### Interface Organization

Follow the [Interface Organization Patterns](docs/interface-organization-patterns.md) when creating/updating interfaces:
- Package-level interfaces: `src/interfaces/`
- Module-level interfaces: `src/some_module/interfaces/`

## Development Notes

- When refactoring, do not introduce backward-compatibility code or preserve legacy pathways:
  1. Refactoring is a forward-only process: architecture and business logic are expected to evolve together.
  2. Use forward-engineered solutions to address current needs, rather than backward-compatible workarounds.
  3. Start refactoring from types and interfaces first. After contracts are updated, refactor implementation code by cascading the changes through downstream dependencies.
- Do not hard-code logic to handle special or test-specific user data. Code should implement general rules and behavior, not conditional branches for specific values introduced solely to make a test pass.
- This project is fully embracing Bun.js ecosystem, so use Bun.js related toolset and solutions as much as possible.

## Claude Code Tool Usage Rules

You must NOT:
- delete files or directories unless explicitly asked
- run rm, mv, chmod, chown recursively

If a destructive or irreversible action is required:
- explain the reasoning
- list affected files
- wait for explicit confirmation
