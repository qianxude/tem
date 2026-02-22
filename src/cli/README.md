# tem CLI

Command-line interface for batch diagnostics and monitoring.

## Installation

The CLI is included with the tem package:

```sh
bun add @qianxude/tem
```

You can run it directly with bun:

```sh
bun run src/cli/index.ts <command> [options]
```

Or install globally:

```sh
bun link
```

## Usage

```
tem <command> [options]
```

## Commands

### `report`

Generate a diagnostic report for batches.

```sh
tem report <db-path> [batch-code]
```

**Arguments:**

- `db-path` - Path to the SQLite database file (required)
- `batch-code` - Specific batch code to report on (optional)

**Options:**

- `--latest` - Report on the most recently created batch
- `--limit-errors N` - Show top N error patterns (default: 10)

**Examples:**

```sh
# Summary report for all batches
tem report ./tem.db

# Detailed report for specific batch
tem report ./tem.db my-batch-code

# Report on latest batch
tem report ./tem.db --latest

# Show top 20 error patterns
tem report ./tem.db my-batch-code --limit-errors 20
```

**Report includes:**

- Batch overview (code, type, status, timestamps, duration)
- Status breakdown with counts and percentages
- Timing analysis (avg/min/max task times, throughput)
- Error patterns for failed tasks
- Retry analysis statistics
- Detection of stuck tasks (running > 5 minutes)

---

### `list`

List tasks with filtering options.

```sh
tem list <db-path>
```

**Arguments:**

- `db-path` - Path to the SQLite database file (required)

**Options:**

- `--batch <code>` - Filter by batch code
- `--status <status>` - Filter by status: `pending`, `running`, `completed`, or `failed`
- `--type <type>` - Filter by task type
- `--limit <n>` - Limit results (default: 100)

**Examples:**

```sh
# List all tasks (up to 100)
tem list ./tem.db

# List failed tasks from a specific batch
tem list ./tem.db --batch my-batch --status failed

# List pending tasks of a specific type
tem list ./tem.db --status pending --type rewrite --limit 20
```

**Output columns:**

- ID - Task UUID
- Batch - Batch code
- Type - Task type
- Status - Current status
- Attempts - Current attempt / max attempts
- Created - Timestamp
- Completed - Completion timestamp
- Error - Truncated error message (if failed)

---

### `watch`

Monitor a running batch in real-time.

```sh
tem watch <db-path> [batch-code]
```

**Arguments:**

- `db-path` - Path to the SQLite database file (required)
- `batch-code` - Specific batch code to watch (optional if using `--latest`)

**Options:**

- `--latest` - Watch the most recently created batch
- `--interval N` - Refresh interval in seconds (default: 5)
- `--timeout N` - Maximum watch time in seconds (default: 3600)
- `--append` - Append reports instead of clearing screen (creates scrollable history)

**Examples:**

```sh
# Watch the latest batch (single report mode)
tem watch ./tem.db --latest

# Watch specific batch with 10-second refresh
tem watch ./tem.db my-batch-code --interval 10

# Watch for up to 5 minutes
tem watch ./tem.db --latest --timeout 300

# Watch with appended reports (scrollable history)
tem watch ./tem.db --latest --append
```

**Watch display includes:**

- Visual progress bar
- Batch status with color coding:
  - 🟢 Green - Completed
  - 🔴 Red - Failed
  - 🟡 Yellow - Running
  - 🔵 Cyan - Pending
- Real-time statistics (pending, running, completed, failed, total)
- Throughput and ETA
- Recent errors (last 3)
- Stuck task warnings (> 5 minutes running)

Press `Ctrl+C` to stop watching. A final report is displayed when the batch completes.

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (database issues, batch not found, timeout) |
| 2 | Usage error (missing arguments, invalid commands/options) |
| 130 | Interrupted by user (SIGINT) |

---

## Global Options

- `--help, -h` - Show help message for any command

## Common Workflows

### Debug a failing batch

```sh
# Watch the batch in one terminal
tem watch ./tem.db my-batch --latest

# In another terminal, list failed tasks
tem list ./tem.db --batch my-batch --status failed

# Generate detailed report
tem report ./tem.db my-batch --limit-errors 20
```

### Monitor a long-running job

```sh
# Watch with longer interval to reduce database queries
tem watch ./tem.db my-batch --interval 30 --timeout 7200
```

### Quick status check

```sh
# Summary of all batches
tem report ./tem.db
```
