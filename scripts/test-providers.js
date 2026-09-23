'use strict';
// Unit tests for provider routing and request shaping. No network: fetch is stubbed.
// Run: node scripts/test-providers.js
const assert = require('assert');
const { credentialsFor, chooseRoute } = require('../lib/route');
const config = require('../lib/config');
const provider = require('../lib/provider');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/** Replace global fetch with one that records the request and streams `chunks`. */
function stubFetch({ status = 200, chunks = [], body = '' } = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return { ok: false, status, text: async () => body, headers: new Map() };
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { done: true }) }) },
    };
  };
  return calls;
}

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

(async () => {
  await test('credentialsFor: gemini uses the Gemini key, URL and fast/smart models', () => {
    const cfg = { ...config.DEFAULTS, provider: 'gemini', geminiApiKey: 'AIzaTEST' };
    const fast = credentialsFor('primary', cfg, false);
    assert.deepStrictEqual(fast, { provider: 'gemini', baseUrl: GEMINI_URL, apiKey: 'AIzaTEST', model: 'gemini-3.5-flash-lite' });
    assert.strictEqual(credentialsFor('primary', cfg, true).model, 'gemini-3.8-flash');
  });

  await test('chatReady: gemini needs a Gemini key, not the OpenAI one', () => {
    assert.strictEqual(config.chatReady({ ...config.DEFAULTS, provider: 'gemini', apiKey: 'sk-x' }), false);
    assert.strictEqual(config.chatReady({ ...config.DEFAULTS, provider: 'gemini', geminiApiKey: 'AIza' }), true);
  });

  await test('screenshots still go to gemini when DeepSeek is configured', () => {
    assert.strictEqual(chooseRoute({ hasScreenshot: true, hasDeepseekKey: true }), 'primary');
  });

  await test('gemini request: max_tokens floored, reasoning_effort passed, stream ends without [DONE]', async () => {
    const calls = stubFetch({ chunks: [sse('Hel'), sse('lo')] });
    let streamed = '';
    const full = await provider.chat('gemini', {
      baseUrl: GEMINI_URL, apiKey: 'AIzaTEST', model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024, reasoningEffort: 'low',
      onDelta: (d) => { streamed += d; },
    });
    assert.strictEqual(full, 'Hello');
    assert.strictEqual(streamed, 'Hello');
    const { url, init, body } = calls[0];
    assert.strictEqual(url, `${GEMINI_URL}/chat/completions`);
    assert.strictEqual(init.headers.Authorization, 'Bearer AIzaTEST');
    assert.strictEqual(body.max_tokens, 8192);
    assert.strictEqual(body.max_completion_tokens, undefined);
    assert.strictEqual(body.reasoning_effort, 'low');
  });

  await test("gemini request: effort 'none' is left out (only 2.5 Flash accepts it)", async () => {
    const calls = stubFetch({ chunks: [sse('x')] });
    await provider.chat('gemini', { baseUrl: GEMINI_URL, apiKey: 'k', model: 'gemini-3.8-flash', messages: [], maxTokens: 20000, reasoningEffort: 'none', onDelta: () => {} });
    assert.strictEqual(calls[0].body.reasoning_effort, undefined);
    assert.strictEqual(calls[0].body.max_tokens, 20000);
  });

  await test('openai request shape is unchanged', async () => {
    const calls = stubFetch({ chunks: [sse('x'), 'data: [DONE]\n\n'] });
    await provider.chat('openai', { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.6-luna', messages: [], maxTokens: 1024, reasoningEffort: 'low', onDelta: () => {} });
    assert.strictEqual(calls[0].body.max_completion_tokens, 1024);
    assert.strictEqual(calls[0].body.max_tokens, undefined);
    assert.strictEqual(calls[0].body.reasoning_effort, 'low');
  });

  await test('gemini bad key (400, array-wrapped error) reads as a key problem', async () => {
    stubFetch({ status: 400, body: '[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]' });
    await assert.rejects(
      provider.chat('gemini', { baseUrl: GEMINI_URL, apiKey: 'bad', model: 'gemini-3.8-flash', messages: [], onDelta: () => {} }),
      /rejected the Gemini API key.*valid API key/,
    );
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
