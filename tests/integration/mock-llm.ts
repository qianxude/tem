import * as i from '../../src/interfaces/index.js';
import { NonRetryableError } from '../../src/core/worker.js';

export interface MockLLMConfig {
  /** Failure rate between 0 and 1 (default: 0.2) */
  failureRate?: number;
  /** Rate limit error rate between 0 and 1 (default: 0.05) */
  rateLimitErrorRate?: number;
  /** Minimum delay in ms (default: 100) */
  minDelay?: number;
  /** Maximum delay in ms (default: 500) */
  maxDelay?: number;
  /** Whether to throw NonRetryableError on certain failures (default: false) */
  useNonRetryableErrors?: boolean;
}

export interface MockLLMInput {
  prompt: string;
  model?: string;
  temperature?: number;
}

export interface MockLLMOutput {
  response: string;
  tokensUsed: number;
  model: string;
}

/**
 * Creates a mock LLM handler that simulates realistic API behavior:
 * - Random delays (100-500ms by default)
 * - Random failures (~20% by default)
 * - Occasional 429 rate limit errors (~5% by default)
 */
export function createMockLLMHandler(config: MockLLMConfig = {}) {
  const {
    failureRate = 0.2,
    rateLimitErrorRate = 0.05,
    minDelay = 100,
    maxDelay = 500,
    useNonRetryableErrors = false,
  } = config;

  const handler: i.TaskHandler<MockLLMInput, MockLLMOutput> = async (
    payload,
    context
  ) => {
    // Simulate random delay
    const delay = minDelay + Math.random() * (maxDelay - minDelay);
    await Bun.sleep(delay);

    // Check for abort
    if (context.signal.aborted) {
      throw new Error('Request aborted');
    }

    // Simulate random failures
    const roll = Math.random();

    if (roll < rateLimitErrorRate) {
      // Rate limit error (429)
      const error = new Error('Rate limit exceeded: Too many requests');
      (error as Error).name = 'RateLimitError';
      throw error;
    }

    if (roll < failureRate) {
      // Random failure
      const errors = [
        'Service temporarily unavailable',
        'Connection timeout',
        'Invalid response from server',
        'Model overloaded',
      ];
      const message = errors[Math.floor(Math.random() * errors.length)];

      if (useNonRetryableErrors && Math.random() < 0.3) {
        // Some errors are non-retryable (e.g., invalid prompt)
        throw new NonRetryableError(`Invalid request: ${message}`);
      }

      throw new Error(message);
    }

    // Success response
    const responseLength = 50 + Math.floor(Math.random() * 200);
    const response = `Mock LLM response for "${payload.prompt.slice(0, 30)}..." (${responseLength} chars)`;

    return {
      response,
      tokensUsed: Math.floor(responseLength / 4) + Math.floor(payload.prompt.length / 4),
      model: payload.model ?? 'gpt-4-mock',
    };
  };

  return handler;
}

/**
 * Creates a deterministic mock handler for consistent testing
 */
export function createDeterministicMockHandler(
  results: Array<{ success: boolean; delay: number; error?: string }>
) {
  let callIndex = 0;

  const handler: i.TaskHandler<MockLLMInput, MockLLMOutput> = async (
    payload,
    context
  ) => {
    const result = results[callIndex++] ?? { success: true, delay: 10 };

    await Bun.sleep(result.delay);

    if (context.signal.aborted) {
      throw new Error('Request aborted');
    }

    if (!result.success) {
      throw new Error(result.error ?? 'Mock error');
    }

    return {
      response: `Response for: ${payload.prompt}`,
      tokensUsed: payload.prompt.length,
      model: 'deterministic-mock',
    };
  };

  return { handler, getCallCount: () => callIndex };
}

/**
 * Creates a handler that tracks call metrics
 */
export function createTrackedMockHandler(config: MockLLMConfig = {}) {
  const metrics = {
    calls: 0,
    successes: 0,
    failures: 0,
    rateLimitErrors: 0,
    totalDelay: 0,
  };

  const baseHandler = createMockLLMHandler(config);

  const handler: i.TaskHandler<MockLLMInput, MockLLMOutput> = async (
    payload,
    context
  ) => {
    const start = Date.now();
    metrics.calls++;

    try {
      const result = await baseHandler(payload, context);
      metrics.successes++;
      metrics.totalDelay += Date.now() - start;
      return result;
    } catch (error) {
      metrics.failures++;
      metrics.totalDelay += Date.now() - start;
      if ((error as Error).message?.includes('Rate limit')) {
        metrics.rateLimitErrors++;
      }
      throw error;
    }
  };

  return { handler, metrics };
}
