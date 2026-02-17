import type * as i from './types';
import { MockService } from './service';

// Generate a simple random ID without external deps
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// JSON response helper
function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Error responses
const errors = {
  serviceNotFound: () => jsonResponse({ error: 'service_not_found' }, 404),
  concurrencyExceeded: () => jsonResponse({ error: 'concurrency_limit_exceeded' }, 503),
  rateLimitExceeded: () => jsonResponse({ error: 'rate_limit_exceeded' }, 429),
  invalidParams: () => jsonResponse({ error: 'invalid_params' }, 400),
  singleModeNoCreate: () => jsonResponse({ error: 'single_mode_no_create' }, 400),
};

// Parse request body safely
async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Validate service config
function validateServiceConfig(body: unknown): i.ServiceConfig | null {
  if (!body || typeof body !== 'object') return null;

  const b = body as Record<string, unknown>;

  // Required: maxConcurrency (number > 0)
  if (typeof b.maxConcurrency !== 'number' || b.maxConcurrency < 1) {
    return null;
  }

  // Required: rateLimit object with limit and windowMs
  if (!b.rateLimit || typeof b.rateLimit !== 'object') return null;
  const rl = b.rateLimit as Record<string, unknown>;
  if (typeof rl.limit !== 'number' || rl.limit < 1) return null;
  if (typeof rl.windowMs !== 'number' || rl.windowMs < 1) return null;

  // Optional: delayMs (defaults to [10, 200])
  let delayMs: [number, number];
  if (b.delayMs && Array.isArray(b.delayMs) && b.delayMs.length === 2) {
    delayMs = [b.delayMs[0], b.delayMs[1]];
  } else {
    delayMs = [10, 200];
  }

  if (delayMs[0] < 0 || delayMs[1] < delayMs[0]) return null;

  return {
    maxConcurrency: b.maxConcurrency,
    rateLimit: { limit: rl.limit, windowMs: rl.windowMs },
    delayMs,
  };
}

// Router state interface - passed as object with getters
interface RouterState {
  services: Map<string, MockService>;
  getMode: () => i.ServerMode;
  getDefaultService: () => MockService | null;
  shutdownFn: () => void;
}

// Create router with state
export function createRouter(state: RouterState) {
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const pathname = url.pathname;
    const mode = state.getMode();

    // POST /shutdown - Shutdown server
    if (method === 'POST' && pathname === '/shutdown') {
      // Schedule shutdown after response
      setTimeout(() => {
        state.shutdownFn();
      }, 100);

      return jsonResponse({ status: 'shutting_down' }, 200);
    }

    // POST /service/:name - Create service
    if (method === 'POST' && pathname.startsWith('/service/')) {
      if (mode === 'single') {
        return errors.singleModeNoCreate();
      }

      const name = pathname.slice('/service/'.length);
      if (!name) return errors.invalidParams();

      const body = await parseBody(req);
      const config = validateServiceConfig(body);
      if (!config) return errors.invalidParams();

      if (state.services.has(name)) {
        // Delete old service if exists
        state.services.delete(name);
      }

      const service = new MockService(name, config);
      state.services.set(name, service);

      return jsonResponse({ service: name, status: 'created' }, 201);
    }

    // DELETE /service/:name - Delete service
    if (method === 'DELETE' && pathname.startsWith('/service/')) {
      if (mode === 'single') {
        return errors.singleModeNoCreate();
      }

      const name = pathname.slice('/service/'.length);
      if (!name) return errors.invalidParams();

      const existed = state.services.delete(name);
      if (!existed) return errors.serviceNotFound();

      return jsonResponse({ service: name, status: 'deleted' }, 200);
    }

    // GET /mock/:name - Access mock service (multi mode)
    // POST /mock/:name - Also supported (body ignored for mock)
    if ((method === 'GET' || method === 'POST') && pathname.startsWith('/mock/')) {
      if (mode === 'single') {
        return errors.invalidParams();
      }

      const name = pathname.slice('/mock/'.length);
      if (!name) return errors.invalidParams();

      const service = state.services.get(name);
      if (!service) return errors.serviceNotFound();

      return handleMockRequest(service);
    }

    // GET / - Access default service (single mode)
    // POST / - Also supported (body ignored for mock)
    if ((method === 'GET' || method === 'POST') && pathname === '/') {
      const defaultService = state.getDefaultService();
      if (mode !== 'single' || !defaultService) {
        return errors.invalidParams();
      }

      return handleMockRequest(defaultService);
    }

    // 404 for unmatched routes
    return jsonResponse({ error: 'not_found' }, 404);
  };
}

// Handle mock service request
async function handleMockRequest(service: MockService): Promise<Response> {
  const startTime = Date.now();

  // Try to acquire (non-blocking)
  const acquireResult = service.tryAcquire();

  if (!acquireResult.allowed) {
    if (acquireResult.error === 'concurrency') {
      return errors.concurrencyExceeded();
    }
    if (acquireResult.error === 'rateLimit') {
      return errors.rateLimitExceeded();
    }
    return errors.invalidParams();
  }

  try {
    // Simulate processing delay
    const delay = service.getDelay();
    await Bun.sleep(delay);

    const rt = Date.now() - startTime;

    const response: i.MockResponse = {
      requestId: generateRequestId(),
      meta: {
        ts: startTime,
        rt,
      },
      data: 'ok',
    };

    return jsonResponse(response, 200);
  } finally {
    // Always release concurrency slot
    service.release();
  }
}
