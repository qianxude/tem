import { Database } from '../../database/index.js';
import {
  formatDuration,
  formatTimestamp,
  formatNumber,
  formatPercent,
  truncate,
} from '../utils/format.js';
import { renderTable, renderKeyValue } from '../utils/table.js';

export interface BatchSummary {
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

export interface TaskTiming {
  avg_time: number;
  min_time: number;
  max_time: number;
}

export interface ErrorPattern {
  error: string;
  count: number;
}

export interface StuckTask {
  id: string;
  type: string;
  claimed_at: string;
  attempt: number;
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

function getAllBatchesSummary(db: Database): BatchSummary[] {
  return db.query<BatchSummary>(
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
    GROUP BY b.id
    ORDER BY b.created_at DESC`
  );
}

function getTaskTiming(db: Database, batchId: string): TaskTiming | null {
  const rows = db.query<TaskTiming>(
    `SELECT
      AVG(
        unixepoch(completed_at) - unixepoch(created_at)
      ) * 1000 as avg_time,
      MIN(
        unixepoch(completed_at) - unixepoch(created_at)
      ) * 1000 as min_time,
      MAX(
        unixepoch(completed_at) - unixepoch(created_at)
      ) * 1000 as max_time
    FROM task
    WHERE batch_id = ?
      AND status = 'completed'
      AND completed_at IS NOT NULL`,
    [batchId]
  );
  return rows[0] || null;
}

function getErrorPatterns(
  db: Database,
  batchId: string,
  limit: number
): ErrorPattern[] {
  return db.query<ErrorPattern>(
    `SELECT
      error,
      COUNT(*) as count
    FROM task
    WHERE batch_id = ?
      AND status = 'failed'
      AND error IS NOT NULL
    GROUP BY error
    ORDER BY count DESC
    LIMIT ?`,
    [batchId, limit]
  );
}

function getRetryStats(
  db: Database,
  batchId: string
): { total_retries: number; tasks_with_retries: number } | null {
  const rows = db.query<{ total_retries: number; tasks_with_retries: number }>(
    `SELECT
      SUM(attempt) as total_retries,
      COUNT(CASE WHEN attempt > 1 THEN 1 END) as tasks_with_retries
    FROM task
    WHERE batch_id = ?
      AND status = 'completed'`,
    [batchId]
  );
  return rows[0] || null;
}

function getStuckTasks(db: Database, batchId: string): StuckTask[] {
  // Tasks that have been running for more than 5 minutes
  return db.query<StuckTask>(
    `SELECT
      id,
      type,
      claimed_at,
      attempt
    FROM task
    WHERE batch_id = ?
      AND status = 'running'
      AND claimed_at < datetime('now', '-5 minutes')`,
    [batchId]
  );
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

function printBatchSummary(summary: BatchSummary): void {
  const status = determineBatchStatus(summary);

  const overviewData = [
    { key: 'Batch Code', value: summary.code },
    { key: 'Type', value: summary.type },
    { key: 'Status', value: status },
    { key: 'Created', value: formatTimestamp(summary.created_at) },
    { key: 'Completed', value: formatTimestamp(summary.completed_at) },
  ];

  if (summary.completed_at) {
    const created = new Date(summary.created_at).getTime();
    const completed = new Date(summary.completed_at).getTime();
    overviewData.push({ key: 'Duration', value: formatDuration(completed - created) });
  }

  console.log('Overview');
  console.log(renderKeyValue(overviewData));
  console.log();

  // Status breakdown
  const total = summary.total || 1; // Avoid division by zero
  const breakdownData = [
    {
      status: 'Total',
      count: formatNumber(summary.total),
      percent: '100%',
    },
    {
      status: 'Pending',
      count: formatNumber(summary.pending),
      percent: formatPercent(summary.pending, total),
    },
    {
      status: 'Running',
      count: formatNumber(summary.running),
      percent: formatPercent(summary.running, total),
    },
    {
      status: 'Completed',
      count: formatNumber(summary.completed),
      percent: formatPercent(summary.completed, total),
    },
    {
      status: 'Failed',
      count: formatNumber(summary.failed),
      percent: formatPercent(summary.failed, total),
    },
  ];

  console.log('Status Breakdown');
  console.log(
    renderTable(
      [
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Count', key: 'count', width: 10, align: 'right' },
        { header: 'Percent', key: 'percent', width: 10, align: 'right' },
      ],
      breakdownData
    )
  );
}

function printDetailedReport(
  db: Database,
  summary: BatchSummary,
  limitErrors: number
): void {
  printBatchSummary(summary);

  // Timing analysis
  const timing = getTaskTiming(db, summary.id);
  if (timing && timing.avg_time !== null) {
    console.log();
    console.log('Timing Analysis');
    const timingData = [
      {
        key: 'Avg Task Time',
        value: formatDuration(Math.round(timing.avg_time)),
      },
      {
        key: 'Min Task Time',
        value: formatDuration(Math.round(timing.min_time)),
      },
      {
        key: 'Max Task Time',
        value: formatDuration(Math.round(timing.max_time)),
      },
    ];

    // Calculate throughput
    if (summary.completed > 0 && timing.avg_time > 0) {
      const tasksPerSecond = 1000 / timing.avg_time;
      timingData.push({
        key: 'Throughput',
        value: `${tasksPerSecond.toFixed(2)} tasks/sec`,
      });
    }

    console.log(renderKeyValue(timingData));
  }

  // Failure analysis
  if (summary.failed > 0) {
    console.log();
    console.log('Failure Analysis');
    const errors = getErrorPatterns(db, summary.id, limitErrors);
    if (errors.length > 0) {
      console.log(
        renderTable(
          [
            { header: 'Count', key: 'count', width: 8, align: 'right' },
            { header: 'Error', key: 'error' },
          ],
          errors.map((e) => ({
            count: formatNumber(e.count),
            error: truncate(e.error, 80),
          }))
        )
      );
    } else {
      console.log('No error details available.');
    }
  }

  // Retry analysis
  const retryStats = getRetryStats(db, summary.id);
  if (retryStats && retryStats.tasks_with_retries > 0) {
    console.log();
    console.log('Retry Analysis');
    const retryData = [
      {
        key: 'Tasks with Retries',
        value: formatNumber(retryStats.tasks_with_retries),
      },
      {
        key: 'Total Retry Attempts',
        value: formatNumber(retryStats.total_retries),
      },
      {
        key: 'Retry Success Rate',
        value: formatPercent(
          retryStats.tasks_with_retries,
          summary.completed
        ),
      },
    ];
    console.log(renderKeyValue(retryData));
  }

  // Stuck task detection
  const stuckTasks = getStuckTasks(db, summary.id);
  if (stuckTasks.length > 0) {
    console.log();
    console.log('Stuck Task Detection (running > 5 minutes)');
    console.log(
      renderTable(
        [
          { header: 'ID', key: 'id', width: 24 },
          { header: 'Type', key: 'type', width: 20 },
          { header: 'Claimed At', key: 'claimed_at', width: 24 },
          { header: 'Attempt', key: 'attempt', width: 8, align: 'right' },
        ],
        stuckTasks.map((t) => ({
          id: t.id.slice(0, 22),
          type: t.type,
          claimed_at: formatTimestamp(t.claimed_at),
          attempt: t.attempt,
        }))
      )
    );
  }
}

function printAllBatchesSummary(db: Database): void {
  const batches = getAllBatchesSummary(db);

  if (batches.length === 0) {
    console.log('No batches found in database.');
    return;
  }

  console.log(`Found ${batches.length} batch(es)`);
  console.log();

  const rows = batches.map((b) => {
    const status = determineBatchStatus(b);
    return {
      code: b.code,
      type: b.type,
      status,
      created: formatTimestamp(b.created_at).slice(0, 19),
      total: formatNumber(b.total),
      pending: formatNumber(b.pending),
      running: formatNumber(b.running),
      completed: formatNumber(b.completed),
      failed: formatNumber(b.failed),
    };
  });

  console.log(
    renderTable(
      [
        { header: 'Code', key: 'code', width: 20 },
        { header: 'Type', key: 'type', width: 16 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Created', key: 'created', width: 20 },
        { header: 'Total', key: 'total', width: 8, align: 'right' },
        { header: 'Pend', key: 'pending', width: 6, align: 'right' },
        { header: 'Run', key: 'running', width: 5, align: 'right' },
        { header: 'Done', key: 'completed', width: 6, align: 'right' },
        { header: 'Fail', key: 'failed', width: 5, align: 'right' },
      ],
      rows
    )
  );
}

export async function reportCommand(
  dbPath: string,
  batchCode: string | undefined,
  flags: Record<string, string | boolean>
): Promise<void> {
  const limitErrors = parseInt(String(flags['limit-errors'] || '10'), 10) || 10;

  const db = openDatabase(dbPath);

  try {
    if (batchCode) {
      // Detailed report for specific batch
      const batch = getBatchByCode(db, batchCode);
      if (!batch) {
        console.error(`Error: Batch "${batchCode}" not found`);
        process.exit(1);
      }
      const summary = getBatchSummary(db, batch.id);
      if (!summary) {
        console.error(`Error: Could not load summary for batch "${batchCode}"`);
        process.exit(1);
      }
      printDetailedReport(db, summary, limitErrors);
    } else if (flags.latest) {
      // Report for latest batch
      const batch = getLatestBatch(db);
      if (!batch) {
        console.error('Error: No batches found in database');
        process.exit(1);
      }
      const summary = getBatchSummary(db, batch.id);
      if (!summary) {
        console.error('Error: Could not load summary for latest batch');
        process.exit(1);
      }
      console.log(`Latest batch: ${batch.code}`);
      console.log();
      printDetailedReport(db, summary, limitErrors);
    } else {
      // Summary of all batches
      printAllBatchesSummary(db);
    }
  } finally {
    db.close();
  }
}
