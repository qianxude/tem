/**
 * TEM Auto-Detect Example
 *
 * This example shows how to use the auto-detect feature to discover
 * API constraints (concurrency and rate limits) before running tasks.
 */

import { TEM, printDetectedConfig } from '../src/index.js';

async function main() {
  // Example 1: Auto-detect OpenAI API constraints
  console.log('Testing against a mock API endpoint...');

  // In a real scenario, you would use actual API credentials:
  // const config = await TEM.detectConstraints({
  //   url: 'https://api.openai.com/v1/chat/completions',
  //   method: 'POST',
  //   headers: {
  //     'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
  //     'Content-Type': 'application/json'
  //   },
  //   body: {
  //     model: 'gpt-4o-mini',
  //     messages: [{ role: 'user', content: 'Hi' }],
  //     max_tokens: 10
  //   },
  //   // Optional: customize detection parameters
  //   timeoutMs: 30000,
  //   maxConcurrencyToTest: 50,
  //   rateLimitTestDurationMs: 10000
  // });

  // For this example, we'll use a hypothetical local endpoint
  try {
    const config = await TEM.detectConstraints({
      url: 'http://localhost:8080/api/test',
      method: 'GET',
      timeoutMs: 5000,
      maxConcurrencyToTest: 20,
      rateLimitTestDurationMs: 5000,
    });

    // Print formatted results
    printDetectedConfig(config, 'http://localhost:8080/api/test');

    // Use detected config for real tasks
    const tem = new TEM({
      databasePath: './tasks.db',
      concurrency: config.concurrency,
      rateLimit: config.rateLimit,
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });

    console.log('TEM initialized with detected configuration');

    // Don't forget to stop TEM when done
    await tem.stop();
  } catch (error) {
    console.error('Auto-detection failed:', error);
    console.log('\nFalling back to conservative defaults...');

    // Use conservative defaults if detection fails
    const tem = new TEM({
      databasePath: './tasks.db',
      concurrency: 2,
      rateLimit: { requests: 10, windowMs: 60000 },
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });

    await tem.stop();
  }
}

main();
