import { Database as SQLiteDatabase, type SQLQueryBindings } from 'bun:sqlite';
import * as i from '../interfaces/index.js';

export interface DatabaseOptions {
  path: string;
  busyTimeout?: number;
}

export class Database implements i.DatabaseConnection {
  private db: SQLiteDatabase;

  constructor(options: DatabaseOptions) {
    this.db = new SQLiteDatabase(options.path);

    // Enable WAL mode for better concurrency
    this.db.exec('PRAGMA journal_mode = WAL;');

    // Set busy timeout for concurrent access safety (default 5 seconds)
    const timeout = options.busyTimeout ?? 5000;
    this.db.exec(`PRAGMA busy_timeout = ${timeout};`);

    // Run migrations
    this.migrate();
  }

  private migrate(): void {
    // Create migration tracking table first
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check and apply migrations in order
    const migrations = [
      { name: '001_initial_schema', apply: () => this.applyInitialSchema() },
      { name: '002_batch_interruption', apply: () => this.applyBatchInterruptionMigration() },
    ];

    for (const migration of migrations) {
      const migrationCount = this.db
        .query('SELECT COUNT(*) as count FROM _migration WHERE name = $name')
        .get({ $name: migration.name }) as { count: number };

      if (migrationCount.count === 0) {
        migration.apply();
      }
    }
  }

  private applyInitialSchema(): void {
    const schema = `
      -- Batch: Groups of related tasks
      CREATE TABLE IF NOT EXISTS batch (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        metadata TEXT
      );

      -- Task: Individual units of work
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        batch_id TEXT REFERENCES batch(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
        payload TEXT NOT NULL,
        result TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempt INTEGER NOT NULL DEFAULT 3,
        claimed_at DATETIME,
        completed_at DATETIME,
        version INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_batch_code ON batch(code);
      CREATE INDEX IF NOT EXISTS idx_batch_type ON batch(type);
      CREATE INDEX IF NOT EXISTS idx_task_batch_id ON task(batch_id);
      CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
      CREATE INDEX IF NOT EXISTS idx_task_type ON task(type);
      CREATE INDEX IF NOT EXISTS idx_task_claim ON task(status, claimed_at);
      CREATE INDEX IF NOT EXISTS idx_task_pending ON task(status, created_at) WHERE status = 'pending';
    `;

    this.transaction(() => {
      this.db.exec(schema);
      this.db
        .query('INSERT INTO _migration (name) VALUES ($name)')
        .run({ $name: '001_initial_schema' });
    });
  }

  private applyBatchInterruptionMigration(): void {
    const migration = `
      -- Add status to batch table
      ALTER TABLE batch ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'interrupted', 'completed'));

      -- Add interruption criteria storage (JSON)
      ALTER TABLE batch ADD COLUMN interruption_criteria TEXT;

      -- Index for quickly finding active batches
      CREATE INDEX IF NOT EXISTS idx_batch_status ON batch(status);

      -- New table: interruption log
      CREATE TABLE IF NOT EXISTS batch_interrupt_log (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        message TEXT NOT NULL,
        stats_snapshot TEXT NOT NULL, -- JSON of BatchStats
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_interrupt_log_batch_id ON batch_interrupt_log(batch_id);
    `;

    this.transaction(() => {
      this.db.exec(migration);
      this.db
        .query('INSERT INTO _migration (name) VALUES ($name)')
        .run({ $name: '002_batch_interruption' });
    });
  }

  query<T = unknown>(sql: string, params?: SQLQueryBindings[]): T[] {
    const stmt = this.db.prepare(sql);
    const results = stmt.all(...(params ?? []));
    stmt.finalize();
    return results as T[];
  }

  run(sql: string, params?: SQLQueryBindings[]): { changes: number } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params ?? []));
    stmt.finalize();
    return { changes: result.changes };
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
