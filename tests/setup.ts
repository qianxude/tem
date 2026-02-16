// Test setup file
// Preloaded before running tests

// Clean up any test databases after all tests
const testDatabases: string[] = [];

export function registerTestDb(path: string): void {
  testDatabases.push(path);
}

// Global teardown
process.on('exit', () => {
  for (const _db of testDatabases) {
    try {
      // Note: In real tests, we'll handle cleanup per-test
      void _db;
    } catch {
      // Ignore cleanup errors on exit
    }
  }
});
