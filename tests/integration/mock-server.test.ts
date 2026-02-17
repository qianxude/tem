import { describe, it, expect, afterEach } from 'bun:test';
import { startMockServer, stopMockServer, getServerState, createMockService } from '../../src/mock-server';

const TEST_PORT = 19999;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe('mock-server', () => {
  afterEach(() => {
    stopMockServer();
  });

  describe('multi mode', () => {
    it('should start server in multi mode', () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });
      const state = getServerState();
      expect(state.mode).toBe('multi');
      expect(state.hasDefaultService).toBe(false);
    });

    it('should create and access a service', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      // Create service
      const createRes = await createMockService('test1', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        delayMs: [10, 20],
      }, BASE_URL);

      expect(createRes.status).toBe(201);
      const createData = await createRes.json();
      expect(createData.service).toBe('test1');
      expect(createData.status).toBe('created');

      // Access service
      const start = Date.now();
      const accessRes = await fetch(`${BASE_URL}/mock/test1`);
      const duration = Date.now() - start;

      expect(accessRes.status).toBe(200);
      const data = await accessRes.json();
      expect(data.requestId).toBeDefined();
      expect(data.meta.ts).toBeDefined();
      expect(data.meta.rt).toBeDefined();
      expect(data.data).toBe('ok');
      expect(duration).toBeGreaterThanOrEqual(10);
    });

    it('should return 404 for non-existent service', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      const res = await fetch(`${BASE_URL}/mock/nonexistent`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('service_not_found');
    });

    it('should return 400 for invalid service config', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      const res = await fetch(`${BASE_URL}/service/bad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxConcurrency: -1, // invalid
          rateLimit: { limit: 10, windowMs: 1000 },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('invalid_params');
    });

    it('should delete a service', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      // Create service
      await createMockService('todelete', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
      }, BASE_URL);

      // Delete service
      const deleteRes = await fetch(`${BASE_URL}/service/todelete`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(200);
      const deleteData = await deleteRes.json();
      expect(deleteData.status).toBe('deleted');

      // Verify deleted
      const accessRes = await fetch(`${BASE_URL}/mock/todelete`);
      expect(accessRes.status).toBe(404);
    });

    it('should enforce concurrency limits', async () => {
      startMockServer({
        port: TEST_PORT,
        mode: 'multi',
      });

      // Create service with concurrency=1 and longer delay
      await createMockService('lowconcurrency', {
        maxConcurrency: 1,
        rateLimit: { limit: 100, windowMs: 1000 },
        delayMs: [100, 100],
      }, BASE_URL);

      // Start first request (holds the slot for 100ms)
      const req1 = fetch(`${BASE_URL}/mock/lowconcurrency`);

      // Immediately send second request (should get 503)
      await Bun.sleep(10); // Small delay to ensure ordering
      const req2 = await fetch(`${BASE_URL}/mock/lowconcurrency`);

      // First request should succeed
      const res1 = await req1;
      expect(res1.status).toBe(200);

      // Second request should be rejected due to concurrency
      expect(req2.status).toBe(503);
      const data2 = await req2.json();
      expect(data2.error).toBe('concurrency_limit_exceeded');
    });

    it('should enforce rate limits', async () => {
      startMockServer({
        port: TEST_PORT,
        mode: 'multi',
      });

      // Create service with rate limit of 2 per 1000ms
      await createMockService('ratelimited', {
        maxConcurrency: 10,
        rateLimit: { limit: 2, windowMs: 1000 },
        delayMs: [1, 1],
      }, BASE_URL);

      // First two requests should succeed
      const res1 = await fetch(`${BASE_URL}/mock/ratelimited`);
      const res2 = await fetch(`${BASE_URL}/mock/ratelimited`);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Third request should be rate limited
      const res3 = await fetch(`${BASE_URL}/mock/ratelimited`);
      expect(res3.status).toBe(429);
      const data3 = await res3.json();
      expect(data3.error).toBe('rate_limit_exceeded');
    });

    it('should return 400 for invalid errorSimulation rate (negative)', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      const res = await createMockService('bad', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        errorSimulation: { rate: -0.1 },
      }, BASE_URL);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('invalid_params');
    });

    it('should return 400 for invalid errorSimulation rate (> 1)', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      const res = await createMockService('bad', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        errorSimulation: { rate: 1.5 },
      }, BASE_URL);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('invalid_params');
    });

    it('should simulate errors at 100% rate with default message', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      await createMockService('err', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        errorSimulation: { rate: 1 },
      }, BASE_URL);

      const res = await fetch(`${BASE_URL}/mock/err`);

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe('internal_server_error');
    });

    it('should simulate errors with custom message', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      await createMockService('err', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        errorSimulation: { rate: 1, errorMessage: 'custom_error' },
      }, BASE_URL);

      const res = await fetch(`${BASE_URL}/mock/err`);

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe('custom_error');
    });

    it('should not simulate errors at 0% rate', async () => {
      startMockServer({ port: TEST_PORT, mode: 'multi' });

      await createMockService('err', {
        maxConcurrency: 2,
        rateLimit: { limit: 10, windowMs: 1000 },
        errorSimulation: { rate: 0 },
      }, BASE_URL);

      const res = await fetch(`${BASE_URL}/mock/err`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data).toBe('ok');
    });
  });

  describe('single mode', () => {
    it('should start server in single mode with default service', async () => {
      startMockServer({
        port: TEST_PORT,
        mode: 'single',
        defaultService: {
          maxConcurrency: 3,
          rateLimit: { limit: 10, windowMs: 1000 },
          delayMs: [5, 10],
        },
      });

      const state = getServerState();
      expect(state.mode).toBe('single');
      expect(state.hasDefaultService).toBe(true);

      // Access default service at root
      const res = await fetch(`${BASE_URL}/`);
      expect(res.status).toBe(200);
    });

    it('should reject service creation in single mode', async () => {
      startMockServer({
        port: TEST_PORT,
        mode: 'single',
        defaultService: {
          maxConcurrency: 3,
          rateLimit: { limit: 10, windowMs: 1000 },
          delayMs: [5, 10],
        },
      });

      const res = await fetch(`${BASE_URL}/service/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxConcurrency: 2,
          rateLimit: { limit: 10, windowMs: 1000 },
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('single_mode_no_create');
    });

    it('should work with errorSimulation in single mode', async () => {
      startMockServer({
        port: TEST_PORT,
        mode: 'single',
        defaultService: {
          maxConcurrency: 3,
          rateLimit: { limit: 10, windowMs: 1000 },
          delayMs: [5, 10],
          errorSimulation: { rate: 1 },
        },
      });

      const res = await fetch(`${BASE_URL}/`);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe('internal_server_error');
    });
  });

  describe('shutdown', () => {
    it('should respond to shutdown endpoint', async () => {
      // Use a different port to avoid conflicts
      const port = TEST_PORT + 1;
      startMockServer({ port, mode: 'multi' });

      const res = await fetch(`http://localhost:${port}/shutdown`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('shutting_down');

      // Wait for shutdown
      await Bun.sleep(200);
    });
  });
});
