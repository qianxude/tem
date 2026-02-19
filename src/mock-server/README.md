# Mock Server

A lightweight HTTP server for simulating external API services with configurable concurrency, rate limiting, and error simulation. Used for testing TEM's task execution capabilities under various load conditions.

## Overview

The mock server provides a controlled environment to test how TEM handles:

- **Concurrency limits** — Simulate services that reject requests when too many are in flight (503 errors)
- **Rate limiting** — Test backoff and retry behavior against rate-limited endpoints (429 errors)
- **Error simulation** — Verify resilience with configurable random failure rates
- **Processing delays** — Verify timeout handling and async processing

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   HTTP Router   │────▶│  MockService    │────▶│ RateLimiter     │
│   (router.ts)   │     │  (service.ts)   │     │ (token bucket)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  Service Mgmt   │     │ Concurrency     │
│  Endpoints      │     │ Controller      │
└─────────────────┘     └─────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `startMockServer` | `server.ts` | Server lifecycle management |
| `createMockService` | `server.ts` | Client helper to create services |
| `createErrorSimulation` | `server.ts` | Helper to create error simulation config |
| `createRouter` | `router.ts` | HTTP routing and request handling |
| `MockService` | `service.ts` | Per-service concurrency and rate limiting |
| `RejectingRateLimiter` | `service.ts` | Token bucket rate limiter with immediate reject |

## Modes

### Single Mode

A simple mode with one pre-configured service accessed at the root path (`/`). No dynamic service management.

**Use case:** Simple tests where you just need a constrained endpoint.

```typescript
startMockServer({
  port: 8080,
  mode: 'single',
  defaultService: {
    maxConcurrency: 3,
    rateLimit: { limit: 10, windowMs: 1000 },
    delayMs: [10, 50],
    errorSimulation: { rate: 0.1, statusCode: 500 }
  }
});
```

### Multi Mode

Dynamic service creation and management. Each service has its own concurrency/rate limits and is accessed via `/mock/:name`.

**Use case:** Complex tests with multiple services having different constraints.

```typescript
startMockServer({ port: 8080, mode: 'multi' });

// Create services dynamically via HTTP API
```

## API Reference

### Single Mode Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` | `/` | Access the default service |
| `POST` | `/shutdown` | Shutdown the server |

### Multi Mode Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/service/:name` | Create or replace a service |
| `DELETE` | `/service/:name` | Delete a service |
| `GET` / `POST` | `/mock/:name` | Access a service |
| `POST` | `/shutdown` | Shutdown the server |

### Create Service (Multi Mode Only)

```http
POST /service/:name
Content-Type: application/json

{
  "maxConcurrency": 2,           // Max concurrent requests (required)
  "rateLimit": {
    "limit": 10,                 // Requests per window (required)
    "windowMs": 1000             // Window size in ms (required)
  },
  "delayMs": [10, 200],          // [min, max] processing delay (optional, default: [10, 200])
  "errorSimulation": {           // Optional error simulation config
    "rate": 0.1,                 // Error rate 0-1 (10% = 0.1)
    "statusCode": 503,           // HTTP status to return (default: 500)
    "errorMessage": "simulated_error"  // Error message (default: "internal_server_error")
  }
}
```

**Response:**
```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "service": "test1",
  "status": "created"
}
```

### Delete Service (Multi Mode Only)

```http
DELETE /service/:name
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "service": "test1",
  "status": "deleted"
}
```

### Access Service

```http
GET /mock/:name        # Multi mode
POST /mock/:name       # Multi mode (body ignored)
GET /                  # Single mode
POST /                 # Single mode (body ignored)
```

**Success Response (200):**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "requestId": "lxyz123-abc456",
  "meta": {
    "ts": 1699999999999,     // Timestamp (ms)
    "rt": 45                  // Response time (ms)
  },
  "data": "ok"
}
```

### Shutdown Server

```http
POST /shutdown
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "shutting_down"
}
```

The server will stop accepting new connections and exit the process after a brief delay.

## Error Responses

| Status | Error Code | Description |
|--------|------------|-------------|
| `400` | `invalid_params` | Missing or invalid request parameters |
| `400` | `single_mode_no_create` | Attempted to create service in single mode |
| `404` | `not_found` | Unknown route |
| `404` | `service_not_found` | Service does not exist |
| `429` | `rate_limit_exceeded` | Rate limit reached |
| `503` | `concurrency_limit_exceeded` | Concurrency limit reached |

### Error Simulation

When `errorSimulation` is configured, requests may randomly fail with:

```http
HTTP/1.1 500 Internal Server Error  // Or configured statusCode
Content-Type: application/json

{
  "error": "internal_server_error"  // Or configured errorMessage
}
```

The error is checked **before** acquiring concurrency/rate limit resources, so simulated errors don't count against limits.

## Configuration

### ServerConfig

```typescript
interface ServerConfig {
  port: number;                    // Server port (required)
  mode?: 'single' | 'multi';       // Server mode (default: 'multi')
  defaultService?: ServiceConfig;  // Required for single mode
}
```

### ServiceConfig

```typescript
interface ServiceConfig {
  maxConcurrency: number;          // Max concurrent requests allowed
  rateLimit: {
    limit: number;                 // Max requests per window
    windowMs: number;              // Window duration in milliseconds
  };
  delayMs: [number, number];       // [min, max] simulated processing delay
  errorSimulation?: {              // Optional error simulation
    rate: number;                  // Error rate 0-1
    statusCode?: number;           // HTTP status code (default: 500)
    errorMessage?: string;         // Error message (default: "internal_server_error")
  };
}
```

### ErrorSimulationConfig

```typescript
interface ErrorSimulationConfig {
  rate: number;        // Error rate 0-1 (e.g., 0.1 = 10% error rate)
  statusCode?: number; // HTTP status code to return (default: 500)
  errorMessage?: string; // Error message (default: "internal_server_error")
}
```

## Usage Examples

### Basic Single Mode

```typescript
import { startMockServer, stopMockServer } from './src/mock-server';

// Start server with a single constrained service
startMockServer({
  port: 8080,
  mode: 'single',
  defaultService: {
    maxConcurrency: 2,
    rateLimit: { limit: 5, windowMs: 1000 },
    delayMs: [50, 100]
  }
});

// Make requests
const response = await fetch('http://localhost:8080/');
const data = await response.json();
// { requestId: '...', meta: { ts: ..., rt: ... }, data: 'ok' }

// Cleanup
stopMockServer();
```

### Multi Mode with Dynamic Services

```typescript
import { startMockServer, stopMockServer } from './src/mock-server';

startMockServer({ port: 8080, mode: 'multi' });

// Create a service with strict limits
await fetch('http://localhost:8080/service/strict', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    maxConcurrency: 1,
    rateLimit: { limit: 2, windowMs: 1000 },
    delayMs: [100, 200]
  })
});

// Create another service with relaxed limits
await fetch('http://localhost:8080/service/relaxed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    maxConcurrency: 10,
    rateLimit: { limit: 100, windowMs: 1000 },
    delayMs: [10, 50]
  })
});

// Access services
const strict = await fetch('http://localhost:8080/mock/strict');
const relaxed = await fetch('http://localhost:8080/mock/relaxed');

// Delete a service
await fetch('http://localhost:8080/service/strict', { method: 'DELETE' });

// Shutdown
await fetch('http://localhost:8080/shutdown', { method: 'POST' });
```

### Testing Concurrency Limits

```typescript
startMockServer({
  port: 8080,
  mode: 'multi'
});

// Create service with concurrency=1
await fetch('http://localhost:8080/service/singleton', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    maxConcurrency: 1,
    rateLimit: { limit: 100, windowMs: 1000 },
    delayMs: [200, 200]  // Fixed 200ms delay
  })
});

// First request starts (holds slot for 200ms)
const req1 = fetch('http://localhost:8080/mock/singleton');

// Second request immediately (should fail with 503)
const req2 = await fetch('http://localhost:8080/mock/singleton');
console.log(req2.status);  // 503
console.log(await req2.json());  // { error: 'concurrency_limit_exceeded' }

await req1;  // First request succeeds
```

### Testing Rate Limits

```typescript
startMockServer({
  port: 8080,
  mode: 'multi'
});

// Create service with rate limit of 2 per second
await fetch('http://localhost:8080/service/ratelimited', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    maxConcurrency: 10,
    rateLimit: { limit: 2, windowMs: 1000 },
    delayMs: [10, 10]
  })
});

// First two succeed
const r1 = await fetch('http://localhost:8080/mock/ratelimited');
const r2 = await fetch('http://localhost:8080/mock/ratelimited');
console.log(r1.status, r2.status);  // 200 200

// Third is rate limited
const r3 = await fetch('http://localhost:8080/mock/ratelimited');
console.log(r3.status);  // 429
console.log(await r3.json());  // { error: 'rate_limit_exceeded' }
```

### Testing Error Simulation

```typescript
import { startMockServer, stopMockServer, createErrorSimulation } from './src/mock-server';

startMockServer({
  port: 8080,
  mode: 'single',
  defaultService: {
    maxConcurrency: 10,
    rateLimit: { limit: 100, windowMs: 1000 },
    delayMs: [10, 50],
    errorSimulation: createErrorSimulation(0.3, 503, "service_unavailable")
  }
});

// Approximately 30% of requests will fail with 503
for (let i = 0; i < 10; i++) {
  const res = await fetch('http://localhost:8080/');
  console.log(res.status);  // Mix of 200 and 503
}
```

## Rate Limiting Algorithm

The mock server uses a **token bucket** algorithm for rate limiting:

- Tokens are refilled continuously based on `limit / windowMs` rate
- Each request consumes 1 token
- If no tokens available, request is rejected immediately (no queueing)
- This provides smooth rate limiting without burst issues

## Concurrency Control

Concurrency is tracked per-service:

- `currentConcurrency` increments on successful `tryAcquire()`
- Decrements when request completes (in `finally` block)
- If `currentConcurrency >= maxConcurrency`, new requests get 503

## Error Simulation

Error simulation is checked before acquiring resources:

```typescript
// Pseudocode
if (Math.random() < errorSimulation.rate) {
  return errorResponse;  // Doesn't consume concurrency/rate limit tokens
}
// Continue with normal request handling...
```

This ensures that simulated errors don't deplete your concurrency slots or rate limit budget.

## Programmatic API

### Server Lifecycle

```typescript
import { startMockServer, stopMockServer, getServerState } from './src/mock-server';

// Start server
startMockServer(config: ServerConfig): void

// Stop server programmatically (for testing)
stopMockServer(): void

// Get current state (for testing)
getServerState(): {
  services: Map<string, MockService>;
  mode: 'single' | 'multi';
  hasDefaultService: boolean;
}
```

### Client Helpers

```typescript
import { createMockService, createErrorSimulation } from './src/mock-server';

// Create a service programmatically (wraps HTTP call)
createMockService(
  name: string,
  config: CreateServiceRequest,
  mockUrl?: string  // defaults to http://localhost:19999
): Promise<Response>

// Create error simulation config with validation
createErrorSimulation(
  rate: number,           // 0-1 error rate
  statusCode?: number,    // HTTP status (default: 500)
  errorMessage?: string   // Error message
): ErrorSimulationConfig
```

Example using client helpers:

```typescript
import { createMockService, createErrorSimulation } from './src/mock-server';

// Create service with error simulation
await createMockService('flaky-api', {
  maxConcurrency: 5,
  rateLimit: { limit: 10, windowMs: 1000 },
  delayMs: [50, 100],
  errorSimulation: createErrorSimulation(0.2, 503)
});

// Use the service
const res = await fetch('http://localhost:19999/mock/flaky-api');
```

## Testing with TEM

The mock server is designed to integrate seamlessly with TEM for testing retry and error handling:

```typescript
import { TEM } from '@qianxude/tem';
import { startMockServer, createMockService, createErrorSimulation } from './src/mock-server';

// Start mock server with flaky service
startMockServer({ port: 19999, mode: 'multi' });

await createMockService('api', {
  maxConcurrency: 3,
  rateLimit: { limit: 10, windowMs: 1000 },
  errorSimulation: createErrorSimulation(0.2)  // 20% failure rate
});

// Configure TEM to match mock server limits
const tem = new TEM({
  databasePath: ':memory:',
  concurrency: 3,
  rateLimit: { requests: 10, windowMs: 1000 }
});

// Register handler that calls mock server
tem.worker.register('test', async (payload) => {
  const res = await fetch('http://localhost:19999/mock/api');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

// TEM's retry mechanism will handle the 20% failure rate
```
