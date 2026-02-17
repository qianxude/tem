import type * as i from './types';
import { MockService } from './service';
import { createRouter } from './router';

const DEFAULT_MOCK_URL = 'http://localhost:19999';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServer = any;

interface ServerState {
  services: Map<string, MockService>;
  mode: i.ServerMode;
  defaultService: MockService | null;
  server: BunServer | null;
}

const globalState: ServerState = {
  services: new Map(),
  mode: 'multi',
  defaultService: null,
  server: null,
};

/**
 * Start the mock server with the given configuration.
 */
export function startMockServer(config: i.ServerConfig): void {
  // Reset state for fresh start
  globalState.services.clear();
  globalState.mode = config.mode ?? 'multi';
  globalState.defaultService = null;

  // Setup default service for single mode
  if (globalState.mode === 'single') {
    if (!config.defaultService) {
      throw new Error('defaultService is required in single mode');
    }
    globalState.defaultService = new MockService('default', config.defaultService);
  }

  // Create router with state
  const router = createRouter({
    services: globalState.services,
    getMode: () => globalState.mode,
    getDefaultService: () => globalState.defaultService,
    shutdownFn: () => shutdown(),
  });

  // Start server
  globalState.server = Bun.serve({
    port: config.port,
    fetch: router,
  });

  console.log(`[INFO] Mock server started on port ${config.port} (${globalState.mode} mode)`);

  if (globalState.mode === 'single') {
    console.log(`[INFO] Default service configured with maxConcurrency=${config.defaultService!.maxConcurrency}`);
  }
}

/**
 * Shutdown the server gracefully.
 */
function shutdown(): void {
  console.log('[INFO] Shutting down mock server...');

  if (globalState.server) {
    globalState.server.stop();
    globalState.server = null;
  }

  globalState.services.clear();
  globalState.defaultService = null;

  console.log('[INFO] Mock server stopped');

  // Exit process
  process.exit(0);
}

/**
 * Get the current server state (for testing).
 */
export function getServerState(): {
  services: Map<string, MockService>;
  mode: i.ServerMode;
  hasDefaultService: boolean;
} {
  return {
    services: globalState.services,
    mode: globalState.mode,
    hasDefaultService: globalState.defaultService !== null,
  };
}

/**
 * Stop the server programmatically (for testing).
 */
export function stopMockServer(): void {
  if (globalState.server) {
    globalState.server.stop();
    globalState.server = null;
  }
  globalState.services.clear();
  globalState.defaultService = null;
}

/**
 * Client helper to create a configured mock service on the mock server.
 * @param name - Unique service name/identifier
 * @param config - Service configuration (concurrency, rate limit, delay)
 * @param mockUrl - Base URL of the mock server (defaults to localhost:19999)
 * @returns The Response object from the fetch call
 */
export async function createMockService(
  name: string,
  config: i.CreateServiceRequest,
  mockUrl: string = DEFAULT_MOCK_URL
): Promise<Response> {
  const res = await fetch(`${mockUrl}/service/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res;
}

/**
 * Helper to create error simulation config with validation.
 * @param rate - Error rate 0-1
 * @param statusCode - HTTP status code (default: 500)
 * @param errorMessage - Error message
 */
export function createErrorSimulation(
  rate: number,
  statusCode?: number,
  errorMessage?: string
): i.ErrorSimulationConfig {
  if (rate < 0 || rate > 1) {
    throw new Error('Error rate must be between 0 and 1');
  }
  return {
    rate,
    statusCode,
    errorMessage,
  };
}
