import { DetectOptions, TEM, printDetectedConfig } from '../src/index.js';

const url = process.env.LLM_BASE_URL!.replace(/\/?$/, '/') + 'chat/completions';
const model = process.env.LLM_MODEL!;

const systemPrompt = await Bun.file('./examples/company_industry_batch.md').text();
const inputData = await Bun.file('./examples/company_industry_input.json').text();

const config: DetectOptions = {
  url,
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: inputData },
    ],
  },
  maxConcurrencyToTest: 20,
  rateLimitTestDurationMs: 30000,
  timeoutMs: 120000,
};
console.log(config);
const result = await TEM.detectConstraints(config);

printDetectedConfig(result, url);
