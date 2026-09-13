'use strict';
// Integration tests for the two child processes added in the capture rewrite:
// the Core Audio tap (lib/systemaudio.js) and the streaming recogniser
// (lib/sidecar.js StreamingSidecar). Both are driven by mock binaries that emit the
// real contracts, so the cases under test are the ones that actually went wrong:
// a channel that silently produces nothing, and a child that dies without a word.
//
// Run: node scripts/test-audio.js
const assert = require('assert');
const path = require('path');

const { SystemAudio, peakOf } = require('../lib/systemaudio');
const { StreamingSidecar } = require('../lib/sidecar');

const TAP = path.join(__dirname, 'mock-audiotee.js');
const STREAM = path.join(__dirname, 'mock-stream-sidecar.js');

let passed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mock binaries read MOCK_MODE from the environment they inherit. */
function withMode(mode, fn) {
  const prev = process.env.MOCK_MODE;
  process.env.MOCK_MODE = mode;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.MOCK_MODE;
      else process.env.MOCK_MODE = prev;
    });
}

// ---------------- peakOf ----------------
test('peakOf reports 0 for digital silence and scales to 1.0', () => {
  assert.strictEqual(peakOf(Buffer.alloc(64)), 0);
  const b = Buffer.alloc(4);
  b.writeInt16LE(-32768, 0);
  b.writeInt16LE(0, 2);
  assert.strictEqual(peakOf(b), 1);
});

// ---------------- SystemAudio ----------------
test('tap: start() resolves on first audio and streams PCM', () => withMode('ok', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 3000 });
  let bytes = 0;
  sa.on('data', (b) => { bytes += b.length; });
  await sa.start();
  assert.ok(sa.isActive(), 'should be active once audio arrives');
  await wait(300);
  sa.stop();
  assert.ok(bytes > 0, `expected PCM, got ${bytes} bytes`);
}));

test('tap: parses the NDJSON it gets on stderr', () => withMode('ok', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 3000 });
  const logs = [];
  sa.on('log', (l) => logs.push(l));
  await sa.start();
  sa.stop();
  assert.ok(logs.some((l) => l.level === 'metadata'), 'metadata line should be parsed');
  assert.ok(logs.some((l) => l.level === 'stream_start'), 'stream_start should be parsed');
}));

test('tap: a tap that never delivers audio rejects with the permission hint', () => withMode('no-audio', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 400 });
  await assert.rejects(() => sa.start(), /no audio within/i);
}));

test('tap: a child that exits during startup rejects with its stderr tail', () => withMode('die', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 2000 });
  await assert.rejects(() => sa.start(), /tap creation failed/);
}));

// The 44-byte them.wav case: the tap is alive and healthy, but nothing is playing.
// That must warn, never fail, because it is indistinguishable from a quiet room.
test('tap: sustained digital silence warns rather than erroring', () => withMode('silent', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 3000, quietMs: 250 });
  const events = [];
  sa.on('quiet', (s) => events.push(['quiet', s]));
  sa.on('error', (e) => events.push(['error', e.message]));
  await sa.start();
  await wait(700);
  sa.stop();
  assert.ok(events.some((e) => e[0] === 'quiet'), 'should emit quiet');
  assert.ok(!events.some((e) => e[0] === 'error'), 'silence is not an error');
}));

// The AirPods case seen in real use: opening the mic makes a Bluetooth device
// renegotiate, its stream format is briefly unreadable, and audiotee dies outright.
// Transient, so it must be retried rather than reported as a dead channel.
test('tap: retries through a transient Core Audio format failure', () => withMode('flaky', async () => {
  const counter = '/tmp/mock-flaky-count-test';
  try { require('fs').unlinkSync(counter); } catch (_) { /* first run */ }
  process.env.MOCK_FLAKY_FILE = counter;
  process.env.MOCK_FLAKY_FAILS = '2';
  try {
    const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 3000, retryDelayMs: 50 });
    await sa.start(); // must survive two crashes and come up on the third
    assert.ok(sa.isActive(), 'should be active after retrying');
    sa.stop();
    const attempts = Number(require('fs').readFileSync(counter, 'utf8'));
    assert.strictEqual(attempts, 3, `expected 3 launches, saw ${attempts}`);
  } finally {
    delete process.env.MOCK_FLAKY_FILE;
    delete process.env.MOCK_FLAKY_FAILS;
    try { require('fs').unlinkSync(counter); } catch (_) { /* fine */ }
  }
}));

test('tap: gives up and reports after exhausting retries', () => withMode('flaky', async () => {
  const counter = '/tmp/mock-flaky-count-test2';
  try { require('fs').unlinkSync(counter); } catch (_) { /* first run */ }
  process.env.MOCK_FLAKY_FILE = counter;
  process.env.MOCK_FLAKY_FAILS = '99'; // never recovers
  try {
    const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 2000, retryDelayMs: 20, startAttempts: 3 });
    await assert.rejects(() => sa.start(), /stream format|device format/i);
    const attempts = Number(require('fs').readFileSync(counter, 'utf8'));
    assert.strictEqual(attempts, 3, `should stop at startAttempts, saw ${attempts}`);
  } finally {
    delete process.env.MOCK_FLAKY_FILE;
    delete process.env.MOCK_FLAKY_FAILS;
    try { require('fs').unlinkSync(counter); } catch (_) { /* fine */ }
  }
}));

test('tap: a stalled tap raises an error rather than going quiet forever', () => withMode('stall', async () => {
  const sa = new SystemAudio({ binaryPath: TAP, firstDataTimeoutMs: 3000, stallMs: 300 });
  const errs = [];
  sa.on('error', (e) => errs.push(e.message));
  await sa.start();
  await wait(900);
  sa.stop();
  assert.ok(errs.some((m) => /stalled/i.test(m)), `expected a stall error, got ${JSON.stringify(errs)}`);
}));

// ---------------- StreamingSidecar ----------------
test('stream: ready handshake, then partials and finals from written PCM', () => withMode('ok', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 3000 });
  const partials = [];
  const finals = [];
  s.on('partial', (t) => partials.push(t));
  s.on('final', (t) => finals.push(t));
  await s.start();
  s.write(Buffer.alloc(32000)); // 1s -> one utterance
  s.write(Buffer.alloc(32000)); // 1s -> another
  await wait(300);
  s.stop();
  assert.deepStrictEqual(finals.slice(0, 2), ['utterance 1', 'utterance 2']);
  assert.ok(partials.length >= 2, `expected partials, got ${partials.length}`);
}));

test('stream: writes before ready are dropped, not thrown', () => withMode('ok', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 3000 });
  assert.doesNotThrow(() => s.write(Buffer.alloc(1024)));
  await s.start();
  s.stop();
}));

test('stream: a child that dies before ready rejects with its stderr tail', () => withMode('die-early', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 3000 });
  await assert.rejects(() => s.start(), /models missing|exited/i);
}));

test('stream: never signalling ready times out instead of hanging forever', () => withMode('no-ready', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 300 });
  await assert.rejects(() => s.start(), /did not become ready/i);
  s.stop();
}));

test('stream: an engine error message surfaces as an error event', () => withMode('engine-err', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 3000 });
  const errs = [];
  s.on('error', (e) => errs.push(e.message));
  await s.start();
  await wait(300);
  s.stop();
  assert.ok(errs.some((m) => /decoder blew up/.test(m)), `expected the engine error, got ${JSON.stringify(errs)}`);
}));

// The failure this whole rewrite exists to prevent: a channel that stops working
// mid-session and says nothing. It must raise, so the UI can show it.
test('stream: dying mid-session raises rather than failing silently', () => withMode('die-midway', async () => {
  const s = new StreamingSidecar({ bin: STREAM, readyTimeoutMs: 3000 });
  const errs = [];
  s.on('error', (e) => errs.push(e.message));
  await s.start();
  s.write(Buffer.alloc(32000));
  await wait(400);
  assert.ok(errs.some((m) => /stopped unexpectedly/i.test(m)), `expected a death notice, got ${JSON.stringify(errs)}`);
}));

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} tests passed`);
})();
