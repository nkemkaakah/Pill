#!/usr/bin/env node
'use strict';
// Mock `fluidaudiocli parakeet-stream` for tests. Emits the exact NDJSON shapes the
// real subcommand writes, and reproduces its failure modes. MOCK_MODE picks which:
//
//   ok          ready, then a partial + final per ~1s of PCM received  (default)
//   no-ready    never emits {"type":"ready"} — start() must time out
//   die-early   exits non-zero before ready — start() must reject with the stderr tail
//   die-midway  emits ready, then exits once audio arrives — must surface as an error
//   engine-err  emits ready, then an {"type":"error"} message

const mode = process.env.MOCK_MODE || 'ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (s) => process.stderr.write(`[mock-stream] ${s}\n`);

log(`args: ${process.argv.slice(2).join(' ')}`);

if (mode === 'die-early') {
  log('models missing and download failed');
  process.exit(3);
}
if (mode === 'no-ready') {
  setTimeout(() => {}, 60000); // hang without ever signalling ready
} else {
  out({ type: 'ready' });
  log('ready');
}

if (mode === 'engine-err') {
  setTimeout(() => out({ type: 'error', message: 'decoder blew up' }), 30);
}

const BYTES_PER_UTTERANCE = 32000; // 1s of 16k s16le
let seen = 0;
let utterance = 0;

process.stdin.on('data', (buf) => {
  if (mode === 'die-midway') {
    log('dying mid-stream');
    process.exit(9);
  }
  seen += buf.length;
  while (seen >= BYTES_PER_UTTERANCE) {
    seen -= BYTES_PER_UTTERANCE;
    utterance += 1;
    out({ type: 'partial', text: `utterance ${utterance} partial` });
    out({ type: 'final', text: `utterance ${utterance}` });
  }
});

process.stdin.on('end', () => {
  out({ type: 'final', text: 'flushed tail' });
  log('stream closed');
  process.exit(0);
});
