import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../src/database/index.js';
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Database', () => {
  let db: Database;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tem-test-'));
    dbPath = join(tempDir, 'test.db');
    db = new Database({ path: dbPath });
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
      rmdirSync(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create database with schema', () => {
      // Verify tables exist by querying them
      const batchTables = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='batch'"
      );
      expect(batchTables.length).toBe(1);

      const taskTables = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task'"
      );
      expect(taskTables.length).toBe(1);
    });

    it('should create indexes', () => {
      const indexes = db.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      );
      expect(indexes.length).toBeGreaterThan(0);
    });

    it('should track migrations', () => {
      const migrations = db.query('SELECT * FROM _migration');
      expect(migrations.length).toBe(1);
    });
  });

  describe('query operations', () => {
    it('should execute parameterized queries', () => {
      const results = db.query('SELECT ? as value, ? as name', [42, 'test']);
      expect(results[0]).toEqual({ value: 42, name: 'test' });
    });

    it('should execute INSERT and SELECT', () => {
      db.run('INSERT INTO batch (id, code, type) VALUES (?, ?, ?)', [
        'test-id',
        'test-code',
        'test-type',
      ]);

      const results = db.query('SELECT * FROM batch WHERE id = ?', ['test-id']);
      expect(results.length).toBe(1);
      expect((results[0] as { code: string }).code).toBe('test-code');
    });
  });

  describe('transactions', () => {
    it('should commit successful transactions', () => {
      db.transaction(() => {
        db.run('INSERT INTO batch (id, code, type) VALUES (?, ?, ?)', [
          'tx-id-1',
          'tx-code',
          'tx-type',
        ]);
      });

      const results = db.query('SELECT * FROM batch WHERE id = ?', ['tx-id-1']);
      expect(results.length).toBe(1);
    });

    it('should rollback failed transactions', () => {
      expect(() => {
        db.transaction(() => {
          db.run('INSERT INTO batch (id, code, type) VALUES (?, ?, ?)', [
            'tx-id-2',
            'tx-code-2',
            'tx-type',
          ]);
          throw new Error('Intentional failure');
        });
      }).toThrow();

      const results = db.query('SELECT * FROM batch WHERE id = ?', ['tx-id-2']);
      expect(results.length).toBe(0);
    });
  });
});
