import { Database } from '../../database/index.js';
import * as i from '../../interfaces/index.js';
import { formatTimestamp, truncate } from '../utils/format.js';
import { renderTable } from '../utils/table.js';

interface TaskRow {
  id: string;
  batch_id: string | null;
  batch_code: string | null;
  type: string;
  status: i.TaskStatus;
  attempt: number;
  max_attempt: number;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

function openDatabase(dbPath: string): Database {
  return new Database({ path: dbPath, busyTimeout: 5000 });
}

function buildTaskQuery(
  db: Database,
  filters: {
    batchCode?: string;
    status?: string;
    type?: string;
    limit: number;
  }
): TaskRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.batchCode) {
    conditions.push('b.code = ?');
    params.push(filters.batchCode);
  }

  if (filters.status) {
    conditions.push('t.status = ?');
    params.push(filters.status);
  }

  if (filters.type) {
    conditions.push('t.type = ?');
    params.push(filters.type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      t.id,
      t.batch_id,
      b.code as batch_code,
      t.type,
      t.status,
      t.attempt,
      t.max_attempt,
      t.created_at,
      t.completed_at,
      t.error
    FROM task t
    LEFT JOIN batch b ON b.id = t.batch_id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT ?
  `;

  params.push(filters.limit);

  return db.query<TaskRow>(sql, params);
}

export async function listCommand(
  dbPath: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const batchCode = String(flags.batch || '');
  const status = String(flags.status || '');
  const type = String(flags.type || '');
  const limit = parseInt(String(flags.limit || '100'), 10) || 100;

  // Validate status if provided
  const validStatuses: i.TaskStatus[] = ['pending', 'running', 'completed', 'failed'];
  if (status && !validStatuses.includes(status as i.TaskStatus)) {
    console.error(
      `Error: Invalid status "${status}". Valid values: ${validStatuses.join(', ')}`
    );
    process.exit(2);
  }

  const db = openDatabase(dbPath);

  try {
    const tasks = buildTaskQuery(db, {
      batchCode: batchCode || undefined,
      status: status || undefined,
      type: type || undefined,
      limit,
    });

    if (tasks.length === 0) {
      console.log('No tasks found matching the criteria.');
      return;
    }

    console.log(`Found ${tasks.length} task(s)`);
    console.log();

    const rows = tasks.map((t) => ({
      id: t.id.slice(0, 22),
      batch: t.batch_code || '-',
      type: truncate(t.type, 20),
      status: t.status,
      attempt: `${t.attempt}/${t.max_attempt}`,
      created: formatTimestamp(t.created_at).slice(0, 19),
      completed: t.completed_at ? formatTimestamp(t.completed_at).slice(0, 19) : '-',
      error: truncate(t.error, 30),
    }));

    console.log(
      renderTable(
        [
          { header: 'ID', key: 'id', width: 24 },
          { header: 'Batch', key: 'batch', width: 16 },
          { header: 'Type', key: 'type', width: 22 },
          { header: 'Status', key: 'status', width: 10 },
          { header: 'Attempt', key: 'attempt', width: 8, align: 'right' },
          { header: 'Created', key: 'created', width: 20 },
          { header: 'Completed', key: 'completed', width: 20 },
          { header: 'Error', key: 'error', width: 32 },
        ],
        rows
      )
    );
  } finally {
    db.close();
  }
}
