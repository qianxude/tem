import * as i from '../interfaces/index.js';
import type { Database } from '../database/index.js';

export interface BatchRow {
  id: string;
  code: string;
  type: string;
  status: i.BatchStatus;
  created_at: string;
  completed_at: string | null;
  metadata: string | null;
  interruption_criteria: string | null;
}

function rowToBatch(row: BatchRow): i.Batch {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    status: row.status ?? 'active',
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    interruptionCriteria: row.interruption_criteria
      ? (JSON.parse(row.interruption_criteria) as i.BatchInterruptionCriteria)
      : null,
  };
}

export class BatchService implements i.BatchService {
  constructor(private db: Database) {}

  async create(input: i.CreateBatchInput): Promise<i.Batch> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO batch (id, code, type, created_at, metadata, interruption_criteria)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.code,
        input.type,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.interruptionCriteria ? JSON.stringify(input.interruptionCriteria) : null,
      ]
    );

    const rows = this.db.query<BatchRow>('SELECT * FROM batch WHERE id = ?', [id]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Failed to create batch');
    }

    return rowToBatch(row);
  }

  async getById(id: string): Promise<i.Batch | null> {
    const rows = this.db.query<BatchRow>('SELECT * FROM batch WHERE id = ?', [id]);
    const row = rows[0];
    if (row === undefined) return null;
    return rowToBatch(row);
  }

  async getByCode(code: string): Promise<i.Batch | null> {
    const rows = this.db.query<BatchRow>('SELECT * FROM batch WHERE code = ?', [code]);
    const row = rows[0];
    if (row === undefined) return null;
    return rowToBatch(row);
  }

  async complete(id: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE batch SET completed_at = ?, status = 'completed' WHERE id = ?`,
      [now, id]
    );
  }

  async list(filter?: { type?: string }): Promise<i.Batch[]> {
    let sql = 'SELECT * FROM batch';
    const params: string[] = [];

    if (filter?.type) {
      sql += ' WHERE type = ?';
      params.push(filter.type);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = this.db.query<BatchRow>(sql, params);
    return rows.map(rowToBatch);
  }

  async getStats(id: string): Promise<i.BatchStats> {
    const result = this.db.query<{ status: i.TaskStatus; count: number }>(
      `SELECT status, COUNT(*) as count FROM task WHERE batch_id = ? GROUP BY status`,
      [id]
    );

    const stats: i.BatchStats = {
      batchId: id,
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of result) {
      stats[row.status] = row.count;
      stats.total += row.count;
    }

    return stats;
  }

  async resume(id: string): Promise<number> {
    const result = this.db.run(
      `UPDATE task SET status = 'pending' WHERE batch_id = ? AND status = 'running'`,
      [id]
    );
    return result.changes ?? 0;
  }

  async retryFailed(id: string): Promise<number> {
    const result = this.db.run(
      `UPDATE task SET status = 'pending', attempt = 0 WHERE batch_id = ? AND status = 'failed'`,
      [id]
    );
    return result.changes ?? 0;
  }

  async updateStatus(id: string, status: i.BatchStatus): Promise<void> {
    this.db.run(
      `UPDATE batch SET status = ? WHERE id = ?`,
      [status, id]
    );
  }

  async getWithCriteria(id: string): Promise<{ batch: i.Batch; criteria: i.BatchInterruptionCriteria | null }> {
    const batch = await this.getById(id);
    if (!batch) {
      throw new Error(`Batch not found: ${id}`);
    }
    return { batch, criteria: batch.interruptionCriteria };
  }
}
