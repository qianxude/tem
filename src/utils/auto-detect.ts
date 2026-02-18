export interface DetectOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxConcurrencyToTest?: number;
  rateLimitTestDurationMs?: number;
  maxRateLimitTestRequests?: number;
}

export interface DetectedConfig {
  concurrency: number;
  rateLimit: {
    requests: number;
    windowMs: number;
  };
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

interface TestResult {
  success: boolean;
  statusCode: number;
  hasConcurrencyErrors: boolean;
  hasRateLimitErrors: boolean;
  retryAfterMs?: number;
  error?: Error;
}

interface ConcurrencyTestResults {
  level: number;
  successCount: number;
  failCount: number;
  hasConcurrencyErrors: boolean;
  hasRateLimitErrors: boolean;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CONCURRENCY = 100;
const DEFAULT_RATE_LIMIT_TEST_DURATION_MS = 10000;
const MAX_RATE_LIMIT_TEST_REQUESTS = 200;

/**
 * Detect API constraints including maximum concurrency and rate limits.
 * Uses binary search for concurrency detection and burst testing for rate limits.
 */
export async function detectConstraints(options: DetectOptions): Promise<DetectedConfig> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency = options.maxConcurrencyToTest ?? DEFAULT_MAX_CONCURRENCY;
  const rateLimitDurationMs = options.rateLimitTestDurationMs ?? DEFAULT_RATE_LIMIT_TEST_DURATION_MS;
  const maxRateLimitTestRequests = options.maxRateLimitTestRequests ?? MAX_RATE_LIMIT_TEST_REQUESTS;

  const requestOptions: RequestOptions = {
    url: options.url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body,
    timeoutMs,
  };

  const notes: string[] = [];

  // Phase 1: Detect concurrency limit
  const detectedConcurrency = await detectConcurrency(requestOptions, maxConcurrency, notes);

  // Phase 2: Detect rate limit using safe concurrency (80% of detected)
  const safeConcurrency = Math.max(1, Math.floor(detectedConcurrency * 0.8));
  const rateLimitResult = await detectRateLimit(requestOptions, safeConcurrency, rateLimitDurationMs, maxRateLimitTestRequests, notes);

  // Calculate confidence
  const confidence = calculateConfidence(detectedConcurrency, rateLimitResult, notes);

  // Generate recommended config with safety margins
  const recommendedConcurrency = Math.max(1, Math.floor(detectedConcurrency * 0.8));
  const recommendedRateLimit = {
    requests: Math.max(1, Math.floor(rateLimitResult.requests * 0.9)),
    windowMs: rateLimitResult.windowMs,
  };

  return {
    concurrency: recommendedConcurrency,
    rateLimit: recommendedRateLimit,
    confidence,
    notes,
  };
}

interface RequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/**
 * Detect maximum concurrency using exponential search followed by binary search.
 */
async function detectConcurrency(
  options: RequestOptions,
  maxToTest: number,
  notes: string[]
): Promise<number> {
  // Phase 1: Exponential search to find upper bound
  let lower = 1;
  let upper = 1;

  while (upper < maxToTest) {
    const result = await testConcurrentRequests(options, upper);

    if (result.hasConcurrencyErrors) {
      notes.push(`Concurrency limit found between ${lower} and ${upper}`);
      break;
    }

    if (result.hasRateLimitErrors) {
      notes.push(`Hit rate limit at concurrency ${upper}, stopping concurrency search`);
      break;
    }

    lower = upper;
    upper *= 2;

    // Stop if we're hitting rate limits consistently
    if (upper > maxToTest) {
      upper = maxToTest;
      break;
    }
  }

  // Phase 2: Binary search for exact limit
  while (lower < upper - 1) {
    const mid = Math.floor((lower + upper) / 2);
    const result = await testConcurrentRequests(options, mid);

    if (result.hasConcurrencyErrors || result.hasRateLimitErrors) {
      upper = mid;
    } else {
      lower = mid;
    }
  }

  // Final verification at detected limit
  const finalResult = await testConcurrentRequests(options, lower);
  if (finalResult.hasConcurrencyErrors) {
    // Edge case: our detected limit actually fails, reduce
    return Math.max(1, lower - 1);
  }

  return lower;
}

/**
 * Test concurrent requests at a specific concurrency level.
 */
async function testConcurrentRequests(
  options: RequestOptions,
  concurrency: number
): Promise<ConcurrencyTestResults> {
  const results: TestResult[] = [];
  const abortController = new AbortController();
  const { signal } = abortController;

  // Create concurrent requests
  const promises: Promise<void>[] = [];
  const semaphore = new SimpleSemaphore(concurrency);

  for (let i = 0; i < concurrency; i++) {
    promises.push(
      (async () => {
        await semaphore.acquire();
        try {
          const result = await makeRequest(options, signal);
          results.push(result);

          // Early abort on auth errors
          if (result.statusCode === 401 || result.statusCode === 403) {
            abortController.abort();
          }
        } finally {
          semaphore.release();
        }
      })()
    );
  }

  await Promise.all(promises);

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;
  const hasConcurrencyErrors = results.some((r) => r.hasConcurrencyErrors);
  const hasRateLimitErrors = results.some((r) => r.hasRateLimitErrors);

  return {
    level: concurrency,
    successCount,
    failCount,
    hasConcurrencyErrors,
    hasRateLimitErrors,
  };
}

/**
 * Detect rate limit by sending bursts of requests and observing patterns.
 */
async function detectRateLimit(
  options: RequestOptions,
  safeConcurrency: number,
  durationMs: number,
  maxRequests: number,
  notes: string[]
): Promise<{ requests: number; windowMs: number }> {
  const startTime = Date.now();
  const requestTimes: number[] = [];
  const rateLimitHitTimes: number[] = [];
  let totalRequests = 0;

  // Send requests as fast as possible at safe concurrency
  while (Date.now() - startTime < durationMs && totalRequests < maxRequests) {
    const batchStart = Date.now();
    const results = await sendBatch(options, safeConcurrency);

    for (const result of results) {
      totalRequests++;
      if (result.success) {
        requestTimes.push(Date.now());
      } else if (result.hasRateLimitErrors) {
        rateLimitHitTimes.push(Date.now());

        // Honor Retry-After header if present
        if (result.retryAfterMs) {
          notes.push(`API returned Retry-After: ${Math.ceil(result.retryAfterMs / 1000)}s`);
          await Bun.sleep(result.retryAfterMs);
        }
      }
    }

    // Small delay between batches to avoid overwhelming
    const batchDuration = Date.now() - batchStart;
    if (batchDuration < 100) {
      await Bun.sleep(100 - batchDuration);
    }
  }

  // Analyze results to determine rate limit
  const analysis = analyzeRateLimitPattern(requestTimes, rateLimitHitTimes, durationMs);

  if (analysis.requestsPerWindow > 0) {
    notes.push(`Rate limit detected: ~${analysis.requestsPerWindow} requests per ${analysis.windowMs / 1000}s window`);
  } else {
    notes.push('No clear rate limit pattern detected, using conservative defaults');
  }

  return {
    requests: analysis.requestsPerWindow || Math.max(10, Math.floor(totalRequests / 2)),
    windowMs: analysis.windowMs || 60000,
  };
}

/**
 * Send a batch of concurrent requests.
 */
async function sendBatch(options: RequestOptions, count: number): Promise<TestResult[]> {
  const promises: Promise<TestResult>[] = [];

  for (let i = 0; i < count; i++) {
    promises.push(makeRequest(options));
  }

  return Promise.all(promises);
}

/**
 * Analyze rate limit patterns from request timing data.
 */
function analyzeRateLimitPattern(
  requestTimes: number[],
  rateLimitHits: number[],
  durationMs: number
): { requestsPerWindow: number; windowMs: number } {
  if (requestTimes.length === 0) {
    return { requestsPerWindow: 0, windowMs: 60000 };
  }

  // If we never hit rate limits, estimate based on throughput
  if (rateLimitHits.length === 0) {
    const throughputPerSecond = requestTimes.length / (durationMs / 1000);
    // Conservative estimate: assume window is 60s
    return {
      requestsPerWindow: Math.floor(throughputPerSecond * 60 * 0.8),
      windowMs: 60000,
    };
  }

  // Look for patterns in rate limit hits to identify window size
  const intervals: number[] = [];
  for (let i = 1; i < rateLimitHits.length; i++) {
    intervals.push(rateLimitHits[i] - rateLimitHits[i - 1]);
  }

  // Common rate limit windows
  const commonWindows = [1000, 5000, 10000, 15000, 20000, 30000, 60000];

  // Try to identify window from pattern
  let detectedWindow = 60000;
  if (intervals.length > 0) {
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    // Find closest common window
    detectedWindow = commonWindows.reduce((closest, window) =>
      Math.abs(window - avgInterval) < Math.abs(closest - avgInterval) ? window : closest
    );
  }

  // Calculate requests per window based on successful requests
  const windowCount = Math.ceil(durationMs / detectedWindow);
  const avgRequestsPerWindow = Math.floor(requestTimes.length / Math.max(1, windowCount));

  return {
    requestsPerWindow: avgRequestsPerWindow,
    windowMs: detectedWindow,
  };
}

/**
 * Make a single HTTP request with timeout.
 */
async function makeRequest(
  options: RequestOptions,
  signal?: AbortSignal
): Promise<TestResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);

  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });

    const statusCode = response.status;

    // Parse Retry-After header
    let retryAfterMs: number | undefined;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      // Try parsing as seconds first, then as HTTP date
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        retryAfterMs = seconds * 1000;
      } else {
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
          retryAfterMs = date.getTime() - Date.now();
        }
      }
    }

    // Also check X-RateLimit-Reset if available
    const rateLimitReset = response.headers.get('x-ratelimit-reset');
    if (rateLimitReset && !retryAfterMs) {
      const resetTime = parseInt(rateLimitReset, 10);
      if (!isNaN(resetTime)) {
        // Could be seconds or milliseconds since epoch
        const resetMs = resetTime > 1000000000000 ? resetTime : resetTime * 1000;
        retryAfterMs = Math.max(0, resetMs - Date.now());
      }
    }

    const isSuccess = response.ok;
    const isConcurrencyError = statusCode === 503 || statusCode === 502;
    const isRateLimitError = statusCode === 429;

    return {
      success: isSuccess,
      statusCode,
      hasConcurrencyErrors: isConcurrencyError,
      hasRateLimitErrors: isRateLimitError,
      retryAfterMs,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';

    return {
      success: false,
      statusCode: isTimeout ? 408 : 0,
      hasConcurrencyErrors: false,
      hasRateLimitErrors: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Simple semaphore for controlling concurrent requests.
 */
class SimpleSemaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

/**
 * Calculate confidence level based on detection results.
 */
function calculateConfidence(
  concurrency: number,
  rateLimit: { requests: number; windowMs: number },
  notes: string[]
): 'high' | 'medium' | 'low' {
  let score = 0;

  // Concurrency detection confidence
  if (concurrency > 1 && concurrency < DEFAULT_MAX_CONCURRENCY) {
    score += 2;
  }

  // Rate limit detection confidence
  if (rateLimit.requests > 0 && rateLimit.windowMs > 0) {
    score += 2;
  }

  // Notes indicate clarity
  if (notes.some((n) => n.includes('clearly') || n.includes('detected'))) {
    score += 1;
  }

  // Penalty for uncertainty indicators
  if (notes.some((n) => n.includes('conservative') || n.includes('no clear'))) {
    score -= 1;
  }

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

/**
 * Print detection results in a formatted way.
 */
export function printDetectedConfig(config: DetectedConfig, url?: string): void {
  console.log('');
  console.log('[TEM Auto-Detect] Results' + (url ? ` for ${url}` : ''));
  console.log('');
  console.log('Detected Limits:');
  console.log(`  - Max Concurrency: ${config.concurrency} requests (80% of detected)`);
  console.log(`  - Rate Limit: ${config.rateLimit.requests} requests per ${config.rateLimit.windowMs / 1000} seconds`);
  console.log('');
  console.log('Recommended Configuration:');
  console.log('  {');
  console.log(`    concurrency: ${config.concurrency},`);
  console.log('    rateLimit: {');
  console.log(`      requests: ${config.rateLimit.requests},`);
  console.log(`      windowMs: ${config.rateLimit.windowMs}`);
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log(`Confidence: ${config.confidence}`);
  if (config.notes.length > 0) {
    console.log('Notes:');
    for (const note of config.notes) {
      console.log(`  - ${note}`);
    }
  }
  console.log('');
}
