import { Database as SQLiteDatabase, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
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
    this.db.run('PRAGMA journal_mode = WAL;');

    // Set busy timeout for concurrent access safety (default 5 seconds)
    const timeout = options.busyTimeout ?? 5000;
    this.db.run(`PRAGMA busy_timeout = ${timeout};`);

    // Initialize schema
    this.initSchema();
  }

  private initSchema(): void {
    // Read schema from file
    const schemaPath = join(import.meta.dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    this.db.run(schema);
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
