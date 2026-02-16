// Mock Server Types
// Import as: import * as i from './types'

export type ServerMode = 'single' | 'multi';

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface ServiceConfig {
  maxConcurrency: number;
  rateLimit: RateLimitConfig;
  delayMs: [number, number];  // [min, max]
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
