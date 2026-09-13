#!/usr/bin/env node
'use strict';
// Mock `audiotee` for tests. Emits the same contract as the real binary: structured
// NDJSON on stderr, raw s16le PCM on stdout. MOCK_MODE picks the behaviour:
//
//   ok        metadata + stream_start, then non-silent PCM forever      (default)
//   silent    same, but every sample is zero — the "tap is up but nothing is playing"
//             case, which must warn rather than error
//   no-audio  logs only, never a single PCM byte — start() must reject
//   stall     emits PCM briefly, then stops without exiting — the watchdog case
//   die       exits non-zero immediately
//   flaky     dies with the real AirPods/Core-Audio format error until a counter file
//             says enough attempts have passed — the transient-retry case

const mode = process.env.MOCK_MODE || 'ok';
const err = (o) => process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);

if (mode === 'flaky') {
  const fs = require('fs');
  const counter = process.env.MOCK_FLAKY_FILE || '/tmp/mock-flaky-count';
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch (_) { n = 0; }
  fs.writeFileSync(counter, String(n + 1));
  if (n < Number(process.env.MOCK_FLAKY_FAILS || 2)) {
    err({ message_type: 'error', data: { message: 'Failed to get device format after device readiness check and retries' } });
    process.stderr.write('audiotee/AudioFormatManager.swift:79: Fatal error: Failed to get stream format from ready device: 150. This indicates a Core Audio subsystem error.\n');
    process.exit(133); // SIGTRAP-ish
  }
}

if (mode === 'die') {
  err({ message_type: 'error', data: { message: 'tap creation failed' } });
  process.exit(4);
}

err({ message_type: 'info', data: { message: 'Starting AudioTee...' } });
err({
  message_type: 'metadata',
  data: { is_float: false, sample_rate: 16000, bits_per_channel: 16, channels_per_frame: 1, encoding: 'pcm_s16le' },
});
err({ message_type: 'stream_start' });

if (mode === 'no-audio') {
  setInterval(() => err({ message_type: 'debug', data: { message: 'waiting for device' } }), 200);
} else {
  const FRAME = 3200; // 100ms of 16k s16le
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    if (mode === 'stall' && ticks > 3) {
      clearInterval(timer);
      err({ message_type: 'debug', data: { message: 'stalled' } });
      // Stay alive but deliver nothing. A process that exits is a different failure
      // (and is covered by the 'die' mode); this is the tap going mute while healthy.
      setInterval(() => {}, 1000);
      return;
    }
    const buf = Buffer.alloc(FRAME);
    if (mode !== 'silent') {
      for (let i = 0; i + 1 < FRAME; i += 2) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i);
    }
    process.stdout.write(buf);
  }, 100);
}

process.on('SIGTERM', () => {
  err({ message_type: 'stream_stop' });
  process.exit(0);
});
