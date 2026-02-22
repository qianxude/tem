import { Database } from '../../database/index.js';
import {
  formatDuration,
  formatTimestamp,
  formatNumber,
  formatPercent,
  truncate,
} from '../utils/format.js';
import { renderTable, renderKeyValue } from '../utils/table.js';

interface BatchSummary {
  id: string;
  code: string;
  type: string;
  created_at: string;
  completed_at: string | null;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

interface TaskTiming {
  avg_execution_time: number;  // Actual execution time (claimed_at to completed_at)
  avg_lifetime: number;        // Total time including queue wait (created_at to completed_at)
}

interface RecentError {
  error: string;
  completed_at: string;
}

interface WatchOptions {
  interval: number;
  timeout: number;
  append: boolean;
  latest: boolean;
}

interface WatchState {
  startTime: number;
  lastUpdateTime: number;
  completedCount: number;
  shouldExit: boolean;
  exitCode: number;
}

function openDatabase(dbPath: string): Database {
  return new Database({ path: dbPath, busyTimeout: 5000 });
}

function getBatchSummary(db: Database, batchId: string): BatchSummary | null {
  const rows = db.query<BatchSummary>(
    `SELECT
      b.id,
      b.code,
      b.type,
      b.created_at,
      b.completed_at,
      COUNT(t.id) as total,
      SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM batch b
    LEFT JOIN task t ON t.batch_id = b.id
    WHERE b.id = ?
    GROUP BY b.id`,
    [batchId]
  );
  return rows[0] || null;
}

function getBatchByCode(db: Database, code: string): { id: string } | null {
  const rows = db.query<{ id: string }>(
    'SELECT id FROM batch WHERE code = ?',
    [code]
  );
  return rows[0] || null;
}

function getLatestBatch(db: Database): { id: string; code: string } | null {
  const rows = db.query<{ id: string; code: string }>(
    'SELECT id, code FROM batch ORDER BY created_at DESC LIMIT 1'
  );
  return rows[0] || null;
}

function getTaskTiming(db: Database, batchId: string): TaskTiming | null {
  const rows = db.query<TaskTiming>(
    `SELECT
      AVG(
        unixepoch(completed_at) - unixepoch(claimed_at)
      ) * 1000 as avg_execution_time,
      AVG(
        unixepoch(completed_at) - unixepoch(created_at)
      ) * 1000 as avg_lifetime
    FROM task
    WHERE batch_id = ?
      AND status = 'completed'
      AND completed_at IS NOT NULL
      AND claimed_at IS NOT NULL`,
    [batchId]
  );
  return rows[0] || null;
}

function getRecentErrors(db: Database, batchId: string, limit: number): RecentError[] {
  return db.query<RecentError>(
    `SELECT
      error,
      completed_at
    FROM task
    WHERE batch_id = ?
      AND status = 'failed'
      AND error IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT ?`,
    [batchId, limit]
  );
}

function getStuckTaskCount(db: Database, batchId: string): number {
  const rows = db.query<{ count: number }>(
    `SELECT COUNT(*) as count
    FROM task
    WHERE batch_id = ?
      AND status = 'running'
      AND claimed_at < datetime('now', '-5 minutes')`,
    [batchId]
  );
  return rows[0]?.count ?? 0;
}

function determineBatchStatus(summary: BatchSummary): string {
  if (summary.failed > 0 && summary.pending === 0 && summary.running === 0) {
    return 'failed';
  }
  if (summary.pending === 0 && summary.running === 0) {
    return 'completed';
  }
  if (summary.running > 0) {
    return 'running';
  }
  return 'pending';
}

function formatElapsed(startTime: number): string {
  const elapsed = Date.now() - startTime;
  return formatDuration(elapsed);
}

function calculateETA(
  summary: BatchSummary,
  avgTaskTimeMs: number | null,
  state: WatchState
): string {
  const remaining = summary.pending + summary.running;
  if (remaining === 0) return 'Complete';
  if (!avgTaskTimeMs || avgTaskTimeMs <= 0) return 'Calculating...';

  // Estimate based on throughput since watch started
  const elapsed = Date.now() - state.startTime;
  const completedSinceStart = summary.completed - state.completedCount;

  if (completedSinceStart > 0 && elapsed > 5000) {
    const throughput = completedSinceStart / (elapsed / 1000);
    const etaSeconds = remaining / throughput;
    return formatDuration(Math.round(etaSeconds * 1000));
  }

  // Fallback to average task time
  const etaMs = remaining * avgTaskTimeMs;
  return formatDuration(Math.round(etaMs));
}

function calculateThroughput(summary: BatchSummary, state: WatchState): string {
  const elapsed = Date.now() - state.startTime;
  if (elapsed < 1000) return '-';

  const completedSinceStart = summary.completed - state.completedCount;
  const throughput = completedSinceStart / (elapsed / 1000);

  if (throughput < 1) {
    return `${(1 / throughput).toFixed(1)}s/task`;
  }
  return `${throughput.toFixed(2)} tasks/sec`;
}

function renderProgressBar(completed: number, failed: number, total: number, width: number = 40): string {
  if (total === 0) return `[${' '.repeat(width)}] 0%`;

  const done = completed + failed;
  const percent = (done / total) * 100;
  const filled = Math.round((done / total) * width);
  const failedCount = Math.round((failed / total) * width);
  const completedCount = filled - failedCount;

  const bar = '█'.repeat(completedCount) + '▓'.repeat(failedCount) + '░'.repeat(width - filled);
  return `[${bar}] ${percent.toFixed(1)}%`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return '\x1b[32m'; // Green
    case 'failed':
      return '\x1b[31m'; // Red
    case 'running':
      return '\x1b[33m'; // Yellow
    default:
      return '\x1b[36m'; // Cyan
  }
}

function resetColor(): string {
  return '\x1b[0m';
}

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function shouldContinueWatching(summary: BatchSummary): boolean {
  const status = determineBatchStatus(summary);
  return status !== 'completed' && status !== 'failed';
}

function renderWatchDisplay(
  summary: BatchSummary,
  timing: TaskTiming | null,
  recentErrors: RecentError[],
  stuckCount: number,
  state: WatchState,
  _options: WatchOptions
): string {
  const lines: string[] = [];
  const status = determineBatchStatus(summary);
  const statusColor = getStatusColor(status);
  const elapsed = Date.now() - new Date(summary.created_at).getTime();

  // Header
  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║  TEM Batch Watch${' '.repeat(51)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  // Batch info
  const headerData = [
    { key: 'Batch', value: summary.code },
    { key: 'Type', value: summary.type },
    { key: 'Status', value: `${statusColor}${status.toUpperCase()}${resetColor()}` },
    { key: 'Elapsed', value: formatDuration(elapsed) },
    { key: 'Watching', value: formatElapsed(state.startTime) },
  ];

  for (const item of headerData) {
    const line = `║  ${(item.key + ':').padEnd(12)} ${item.value.toString().padEnd(52)}║`;
    lines.push(line);
  }
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  // Progress bar
  lines.push('║  Progress                                                        ║');
  lines.push(`║  ${renderProgressBar(summary.completed, summary.failed, summary.total).padEnd(64)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  // Stats table
  lines.push('║  Statistics                                                      ║');
  const total = summary.total || 1;
  const statsData = [
    { status: 'Pending', count: summary.pending, percent: formatPercent(summary.pending, total) },
    { status: 'Running', count: summary.running, percent: formatPercent(summary.running, total) },
    { status: 'Completed', count: summary.completed, percent: formatPercent(summary.completed, total) },
    { status: 'Failed', count: summary.failed, percent: formatPercent(summary.failed, total) },
    { status: 'Total', count: summary.total, percent: '100%' },
  ];

  for (const stat of statsData) {
    const line = `║    ${stat.status.padEnd(12)} ${formatNumber(stat.count).padStart(10)}  ${stat.percent.padStart(6)}${' '.repeat(28)}║`;
    lines.push(line);
  }
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  // Timing info
  lines.push('║  Performance                                                     ║');
  const throughput = calculateThroughput(summary, state);
  const eta = calculateETA(summary, timing?.avg_lifetime ?? null, state);
  const perfData = [
    { key: 'Throughput', value: throughput },
    { key: 'ETA', value: eta },
  ];

  if (timing?.avg_execution_time) {
    perfData.push({ key: 'Avg Execution', value: formatDuration(Math.round(timing.avg_execution_time)) });
  }
  if (timing?.avg_lifetime) {
    perfData.push({ key: 'Avg Lifetime', value: formatDuration(Math.round(timing.avg_lifetime)) });
  }

  for (const item of perfData) {
    const line = `║  ${(item.key + ':').padEnd(12)} ${item.value.toString().padEnd(52)}║`;
    lines.push(line);
  }

  // Stuck tasks warning
  if (stuckCount > 0) {
    lines.push('╠══════════════════════════════════════════════════════════════════╣');
    lines.push(`║  ⚠ WARNING: ${stuckCount} task(s) stuck > 5 minutes${' '.repeat(37)}║`);
  }

  // Recent errors
  if (recentErrors.length > 0) {
    lines.push('╠══════════════════════════════════════════════════════════════════╣');
    lines.push('║  Recent Failures                                                 ║');
    for (const error of recentErrors.slice(0, 3)) {
      const errorMsg = truncate(error.error, 58);
      const line = `║    • ${errorMsg.padEnd(60)}║`;
      lines.push(line);
    }
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push(`Last update: ${new Date().toISOString()}`);

  return lines.join('\n');
}

function renderFinalReport(
  summary: BatchSummary,
  timing: TaskTiming | null,
  recentErrors: RecentError[],
  stuckCount: number,
  state: WatchState
): string {
  const lines: string[] = [];
  const status = determineBatchStatus(summary);
  const elapsed = Date.now() - new Date(summary.created_at).getTime();

  lines.push('');
  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('                    BATCH COMPLETED - FINAL REPORT');
  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('');

  // Overview
  lines.push('Overview');
  const overviewData = [
    { key: 'Batch Code', value: summary.code },
    { key: 'Type', value: summary.type },
    { key: 'Status', value: status },
    { key: 'Created', value: formatTimestamp(summary.created_at) },
    { key: 'Duration', value: formatDuration(elapsed) },
  ];
  lines.push(renderKeyValue(overviewData));
  lines.push('');

  // Status breakdown
  lines.push('Status Breakdown');
  const total = summary.total || 1;
  const breakdownData = [
    { status: 'Total', count: formatNumber(summary.total), percent: '100%' },
    { status: 'Pending', count: formatNumber(summary.pending), percent: formatPercent(summary.pending, total) },
    { status: 'Running', count: formatNumber(summary.running), percent: formatPercent(summary.running, total) },
    { status: 'Completed', count: formatNumber(summary.completed), percent: formatPercent(summary.completed, total) },
    { status: 'Failed', count: formatNumber(summary.failed), percent: formatPercent(summary.failed, total) },
  ];
  lines.push(renderTable(
    [
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Count', key: 'count', width: 10, align: 'right' },
      { header: 'Percent', key: 'percent', width: 10, align: 'right' },
    ],
    breakdownData
  ));

  // Timing
  if (timing && timing.avg_execution_time !== null) {
    lines.push('');
    lines.push('Timing Analysis');
    const elapsedWatch = Date.now() - state.startTime;
    const completedSinceStart = summary.completed - state.completedCount;
    let throughput = '-';
    if (elapsedWatch > 0 && completedSinceStart > 0) {
      const tps = completedSinceStart / (elapsedWatch / 1000);
      throughput = tps < 1 ? `${(1 / tps).toFixed(1)}s/task` : `${tps.toFixed(2)} tasks/sec`;
    }

    const timingData = [
      { key: 'Avg Execution', value: formatDuration(Math.round(timing.avg_execution_time)) },
      { key: 'Avg Lifetime', value: formatDuration(Math.round(timing.avg_lifetime)) },
      { key: 'Throughput', value: throughput },
    ];
    lines.push(renderKeyValue(timingData));
  }

  // Stuck tasks
  if (stuckCount > 0) {
    lines.push('');
    lines.push(`⚠ WARNING: ${stuckCount} task(s) were stuck > 5 minutes`);
  }

  // Errors
  if (recentErrors.length > 0) {
    lines.push('');
    lines.push('Recent Failures');
    const errorData = recentErrors.slice(0, 5).map(e => ({
      time: formatTimestamp(e.completed_at).slice(0, 19),
      error: truncate(e.error, 60),
    }));
    lines.push(renderTable(
      [
        { header: 'Time', key: 'time', width: 20 },
        { header: 'Error', key: 'error' },
      ],
      errorData
    ));
  }

  lines.push('');
  lines.push('════════════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

export async function watchCommand(
  dbPath: string,
  batchCode: string | undefined,
  flags: Record<string, string | boolean>
): Promise<void> {
  const options: WatchOptions = {
    interval: (parseInt(String(flags['interval'] || '5'), 10) || 5) * 1000,
    timeout: (parseInt(String(flags['timeout'] || '3600'), 10) || 3600) * 1000,
    append: flags['append'] === true,
    latest: flags['latest'] === true,
  };

  const db = openDatabase(dbPath);

  // Resolve batch
  let batchId: string;
  let resolvedBatchCode: string;

  try {
    if (batchCode) {
      const batch = getBatchByCode(db, batchCode);
      if (!batch) {
        console.error(`Error: Batch "${batchCode}" not found`);
        process.exit(1);
      }
      batchId = batch.id;
      resolvedBatchCode = batchCode;
    } else if (options.latest) {
      const batch = getLatestBatch(db);
      if (!batch) {
        console.error('Error: No batches found in database');
        process.exit(1);
      }
      batchId = batch.id;
      resolvedBatchCode = batch.code;
    } else {
      console.error('Error: Either provide a batch-code or use --latest flag');
      process.exit(2);
    }

    // Get initial summary
    let summary = getBatchSummary(db, batchId);
    if (!summary) {
      console.error(`Error: Could not load summary for batch "${resolvedBatchCode}"`);
      process.exit(1);
    }

    // If already completed/failed, just print report and exit
    const initialStatus = determineBatchStatus(summary);
    if (initialStatus === 'completed' || initialStatus === 'failed') {
      const timing = getTaskTiming(db, batchId);
      const recentErrors = getRecentErrors(db, batchId, 5);
      const stuckCount = getStuckTaskCount(db, batchId);
      const state: WatchState = {
        startTime: Date.now(),
        lastUpdateTime: Date.now(),
        completedCount: summary.completed,
        shouldExit: false,
        exitCode: 0,
      };
      console.log(renderFinalReport(summary, timing, recentErrors, stuckCount, state));
      process.exit(0);
    }

    // Initialize watch state
    const state: WatchState = {
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      completedCount: summary.completed,
      shouldExit: false,
      exitCode: 0,
    };

    // Set up SIGINT handler
    let sigintReceived = false;
    process.on('SIGINT', () => {
      if (sigintReceived) {
        process.exit(130);
      }
      sigintReceived = true;
      state.shouldExit = true;
      state.exitCode = 130;
    });

    // Initial render
    if (!options.append) clearScreen();
    const timing = getTaskTiming(db, batchId);
    const recentErrors = getRecentErrors(db, batchId, 3);
    const stuckCount = getStuckTaskCount(db, batchId);
    console.log(renderWatchDisplay(summary, timing, recentErrors, stuckCount, state, options));

    // Watch loop
    return new Promise((_resolve) => {
      const intervalId = setInterval(() => {
        // Check timeout
        if (Date.now() - state.startTime > options.timeout) {
          clearInterval(intervalId);
          if (!options.append) clearScreen();
          console.error('Watch timeout reached');
          db.close();
          process.exit(1);
        }

        // Check if should exit
        if (state.shouldExit) {
          clearInterval(intervalId);
          if (!options.append) clearScreen();
          console.log('\nWatch interrupted by user');
          db.close();
          process.exit(state.exitCode);
        }

        // Refresh data
        summary = getBatchSummary(db, batchId);
        if (!summary) {
          clearInterval(intervalId);
          console.error('Error: Could not refresh batch data');
          db.close();
          process.exit(1);
        }

        // Render update
        if (options.append) {
          // Print separator between reports in append mode
          console.log('\n' + '─'.repeat(70));
        } else {
          clearScreen();
        }
        const timing = getTaskTiming(db, batchId);
        const recentErrors = getRecentErrors(db, batchId, 3);
        const stuckCount = getStuckTaskCount(db, batchId);
        console.log(renderWatchDisplay(summary, timing, recentErrors, stuckCount, state, options));

        // Check if batch is done
        if (!shouldContinueWatching(summary)) {
          clearInterval(intervalId);
          if (options.append) {
            console.log('\n' + '═'.repeat(70));
          } else {
            clearScreen();
          }
          console.log(renderFinalReport(summary, timing, recentErrors, stuckCount, state));
          db.close();
          process.exit(0);
        }

        state.lastUpdateTime = Date.now();
      }, options.interval);
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
