// Mock Server Types
// Import as: import * as i from './types'

export type ServerMode = 'single' | 'multi';

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface ErrorSimulationConfig {
  rate: number;        // Error rate 0-1 (e.g., 0.1 = 10% error rate)
  statusCode?: number; // HTTP status code to return (default: 500)
  errorMessage?: string; // Error message (default: "internal_server_error")
}

export interface ServiceConfig {
  maxConcurrency: number;
  rateLimit: RateLimitConfig;
  delayMs: [number, number];  // [min, max]
  errorSimulation?: ErrorSimulationConfig;  // Optional error simulation
}

export interface ServerConfig {
  port: number;
  mode?: ServerMode;
  defaultService?: ServiceConfig;
}

export interface CreateServiceRequest {
  maxConcurrency: number;
  rateLimit: RateLimitConfig;
  delayMs?: [number, number];  // [min, max], defaults to [10, 200]
  errorSimulation?: ErrorSimulationConfig;  // Optional error simulation
}

export interface ServiceResponse {
  service: string;
  status: string;
}

export interface MockResponse {
  requestId: string;
  meta: {
    ts: number;
    rt: number;
  };
  data: string;
}

export interface ErrorResponse {
  error: string;
}

export interface ShutdownResponse {
  status: string;
}

export interface TryAcquireResult {
  allowed: boolean;
  error?: 'concurrency' | 'rateLimit';
}
