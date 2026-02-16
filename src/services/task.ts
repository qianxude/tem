import * as i from '../interfaces/index.js';
import type { Database } from '../database/index.js';

export interface TaskRow {
  id: string;
  batch_id: string | null;
  type: string;
  status: i.TaskStatus;
  payload: string;
  result: string | null;
  error: string | null;
  attempt: number;
  max_attempt: number;
  claimed_at: string | null;
  completed_at: string | null;
  version: number;
  created_at: string;
}

function rowToTask(row: TaskRow): i.Task {
  return {
    id: row.id,
    batchId: row.batch_id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    result: row.result,
    error: row.error,
    attempt: row.attempt,
    maxAttempt: row.max_attempt,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    version: row.version,
    createdAt: new Date(row.created_at),
  };
}

export class TaskService implements i.TaskService {
  constructor(private db: Database) {}

  async create(input: i.CreateTaskInput): Promise<i.Task> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxAttempt = input.maxAttempt ?? 3;

    this.db.run(
      `INSERT INTO task (id, batch_id, type, status, payload, max_attempt, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        input.batchId ?? null,
        input.type,
        JSON.stringify(input.payload),
        maxAttempt,
        now,
      ]
    );

    const rows = this.db.query<TaskRow>('SELECT * FROM task WHERE id = ?', [id]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Failed to create task');
    }

    return rowToTask(row);
  }

  async createMany(inputs: i.CreateTaskInput[]): Promise<i.Task[]> {
    const tasks: i.Task[] = [];

    this.db.transaction(() => {
      for (const input of inputs) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const maxAttempt = input.maxAttempt ?? 3;

        this.db.run(
          `INSERT INTO task (id, batch_id, type, status, payload, max_attempt, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          [
            id,
            input.batchId ?? null,
            input.type,
            JSON.stringify(input.payload),
            maxAttempt,
            now,
          ]
        );

        const rows = this.db.query<TaskRow>('SELECT * FROM task WHERE id = ?', [id]);
        const row = rows[0];
        if (row === undefined) {
          throw new Error('Failed to create task');
        }

        tasks.push(rowToTask(row));
      }
    });

    return tasks;
  }

  async getById(id: string): Promise<i.Task | null> {
    const rows = this.db.query<TaskRow>('SELECT * FROM task WHERE id = ?', [id]);
    const row = rows[0];
    if (row === undefined) return null;
    return rowToTask(row);
  }

  async claim(batchId?: string): Promise<i.Task | null> {
    const now = new Date().toISOString();

    // Atomic claim using UPDATE ... WHERE status='pending'
    // This ensures no duplicate execution even with concurrent async operations
    const claimed = this.db.query<TaskRow>(
      `UPDATE task
       SET status = 'running',
           claimed_at = ?,
           version = version + 1,
           attempt = attempt + 1
       WHERE id = (
         SELECT id FROM task
         WHERE status = 'pending'
           AND (batch_id = ? OR ? IS NULL)
         ORDER BY created_at
         LIMIT 1
       )
       AND status = 'pending'
       RETURNING *`,
      [now, batchId ?? null, batchId ?? null]
    );

    const row = claimed[0];
    if (row === undefined) return null;
    return rowToTask(row);
  }

  async complete(id: string, result: unknown): Promise<void> {
    const now = new Date().toISOString();

    this.db.run(
      `UPDATE task
       SET status = 'completed',
           result = ?,
           completed_at = ?,
           version = version + 1
       WHERE id = ?`,
      [JSON.stringify(result), now, id]
    );
  }

  async fail(id: string, error: string): Promise<void> {
    const now = new Date().toISOString();

    this.db.run(
      `UPDATE task
       SET status = 'failed',
           error = ?,
           completed_at = ?,
           version = version + 1
       WHERE id = ?`,
      [error, now, id]
    );
  }

  async retry(id: string): Promise<void> {
    this.db.run(
      `UPDATE task
       SET status = 'pending',
           claimed_at = NULL,
           version = version + 1
       WHERE id = ?`,
      [id]
    );
  }
}
