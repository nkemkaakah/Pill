'use strict';
// Unit tests for the pure pipeline logic. Run: node scripts/test-lib.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SAMPLE_RATE, WavWriter, Resampler, floatToInt16, mixToMono, readWav } = require('../lib/wav');
const align = require('../lib/align');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------- wav ----------------
test('WavWriter writes a valid header and patches sizes', () => {
  const f = path.join(os.tmpdir(), `pill-test-${Date.now()}.wav`);
  const w = new WavWriter(f);
  const tone = new Int16Array(16000); // 1s
  for (let i = 0; i < tone.length; i++) tone[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 20000);
  w.append(tone.subarray(0, 7000));
  w.append(tone.subarray(7000));
  const res = w.finish();
  assert.strictEqual(res.bytes, 44 + 32000);
  assert.ok(Math.abs(res.seconds - 1) < 1e-9);
  const parsed = readWav(f);
  assert.strictEqual(parsed.sampleRate, SAMPLE_RATE);
  assert.strictEqual(parsed.channels, 1);
  assert.strictEqual(parsed.bits, 16);
  assert.strictEqual(parsed.dataBytes, 32000);
  assert.strictEqual(parsed.samples.length, 16000);
  assert.strictEqual(parsed.samples[100], tone[100]);
  fs.unlinkSync(f);
});

test('Resampler 48k->16k keeps duration and is seamless across chunk splits', () => {
  const from = 48000;
  const seconds = 2;
  const input = new Float32Array(from * seconds);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 5 * i) / from); // 5 Hz ramp-ish
  // whole-buffer pass
  const whole = new Resampler(from).process(input);
  // chunked pass with awkward chunk sizes
  const chunked = [];
  const r = new Resampler(from);
  let off = 0;
  const sizes = [1, 480, 1000, 4801, 7919];
  let k = 0;
  while (off < input.length) {
    const n = Math.min(sizes[k++ % sizes.length], input.length - off);
    chunked.push(...r.process(input.subarray(off, off + n)));
    off += n;
  }
  assert.ok(Math.abs(whole.length - 16000 * seconds) <= 2, `whole length ${whole.length}`);
  assert.ok(Math.abs(chunked.length - whole.length) <= 2, `chunked length ${chunked.length} vs ${whole.length}`);
  for (let i = 0; i < Math.min(whole.length, chunked.length); i++) {
    assert.ok(Math.abs(whole[i] - chunked[i]) < 1e-6, `sample ${i} differs`);
  }
  // signal shape preserved: correlation with an ideally-sampled sine ~ 1
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < whole.length; i++) {
    const ideal = Math.sin((2 * Math.PI * 5 * i) / 16000);
    dot += whole[i] * ideal; na += whole[i] ** 2; nb += ideal ** 2;
  }
  assert.ok(dot / Math.sqrt(na * nb) > 0.999);
});

test('floatToInt16 clips and scales', () => {
  const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  assert.deepStrictEqual(Array.from(out), [0, 32767, -32768, 32767, -32768, 16384]);
});

test('mixToMono averages channels', () => {
  const m = mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  assert.deepStrictEqual(Array.from(m), [0.5, 0.5]);
});

// ---------------- align ----------------
const seg = (speakerId, s, e, embedding = [1, 0], qualityScore = 1) => ({ speakerId, embedding, startTimeSeconds: s, endTimeSeconds: e, qualityScore });
const word = (w, s, e) => ({ word: w, startTime: s, endTime: e, confidence: 0.9 });

test('alignWordsToSegments assigns by overlap and groups utterances', () => {
  const segments = [seg('S0', 0, 5), seg('S1', 5.2, 10)];
  const words = [word('hello', 0.1, 0.5), word('there', 0.6, 1.0), word('hi', 5.4, 5.8), word('back', 6.0, 6.4)];
  const utt = align.alignWordsToSegments(words, segments);
  assert.strictEqual(utt.length, 2);
  assert.deepStrictEqual(utt[0], { speakerKey: 'S0', start: 0.1, end: 1.0, text: 'hello there' });
  assert.deepStrictEqual(utt[1], { speakerKey: 'S1', start: 5.4, end: 6.4, text: 'hi back' });
});

test('alignWordsToSegments: word straddling two segments goes to bigger overlap', () => {
  const segments = [seg('S0', 0, 1.0), seg('S1', 1.0, 3)];
  const utt = align.alignWordsToSegments([word('mid', 0.8, 1.6)], segments);
  assert.strictEqual(utt[0].speakerKey, 'S1'); // 0.6s in S1 vs 0.2s in S0
});

test('alignWordsToSegments: word outside all segments snaps to nearest edge within tolerance', () => {
  const segments = [seg('S0', 10, 12)];
  const utt = align.alignWordsToSegments([word('early', 9.2, 9.5), word('way', 2.0, 2.3)], segments);
  assert.strictEqual(utt.find((u) => u.text.includes('early')).speakerKey, 'S0');
  assert.strictEqual(utt.find((u) => u.text.includes('way')).speakerKey, 'unknown');
});

test('wordsToUtterances splits on silence gaps', () => {
  const utt = align.wordsToUtterances([word('one', 0, 0.4), word('two', 0.6, 1.0), word('later', 5.0, 5.4)], 'me');
  assert.strictEqual(utt.length, 2);
  assert.strictEqual(utt[0].text, 'one two');
  assert.strictEqual(utt[1].text, 'later');
  assert.strictEqual(utt[1].speakerKey, 'me');
});

test('mergeTimelines interleaves by start time', () => {
  const merged = align.mergeTimelines(
    [{ speakerKey: 'me', start: 1, end: 2, text: 'a' }],
    [{ speakerKey: 'S0', start: 0, end: 0.5, text: 'b' }, { speakerKey: 'S0', start: 3, end: 4, text: 'c' }],
  );
  assert.deepStrictEqual(merged.map((u) => u.text), ['b', 'a', 'c']);
});

test('speakerVoiceprints weights by duration x quality', () => {
  const vps = align.speakerVoiceprints([
    seg('S0', 0, 10, [1, 0], 1),     // weight 10
    seg('S0', 10, 11, [0, 1], 0.5),  // weight 0.5
    seg('S1', 0, 2, [0, 1], 1),
  ]);
  const s0 = vps.get('S0');
  assert.ok(s0.embedding[0] > 0.9 && s0.embedding[1] < 0.1);
  assert.strictEqual(Math.round(s0.seconds), 11);
  assert.deepStrictEqual(vps.get('S1').embedding, [0, 1]);
});

test('speakerVoiceprints skips malformed segments', () => {
  const vps = align.speakerVoiceprints([seg('S0', 0, 1, [], 1), seg('S0', 1, 1, [1, 0], 1)]);
  assert.strictEqual(vps.size, 0);
});

test('cosine basics', () => {
  assert.strictEqual(align.cosine([1, 0], [1, 0]), 1);
  assert.strictEqual(align.cosine([1, 0], [0, 1]), 0);
  assert.strictEqual(align.cosine([1, 0], [0]), 0);
  assert.strictEqual(align.cosine([0, 0], [0, 0]), 0);
});

test('matchSpeakers: greedy best-first, one known per anon, threshold respected', () => {
  const vps = new Map([
    ['S0', { embedding: [1, 0, 0], seconds: 30 }],
    ['S1', { embedding: [0.9, 0.1, 0], seconds: 20 }],
    ['S2', { embedding: [0, 0, 1], seconds: 10 }],
  ]);
  const known = [
    { uid: 'g', name: 'Gareth', embedding: [1, 0, 0] },
    { uid: 'k', name: 'Karthik', embedding: [0, 1, 0] },
  ];
  const m = align.matchSpeakers(vps, known, { threshold: 0.45 });
  assert.strictEqual(m.get('S0').name, 'Gareth');       // exact match wins Gareth
  assert.strictEqual(m.get('S1').name, null);           // Gareth already taken; Karthik sim ~0.11 < threshold
  assert.strictEqual(m.get('S2').name, null);
});

test('displayNames: matched names then Speaker N by first appearance', () => {
  const utt = [
    { speakerKey: 'S1', start: 0, end: 1, text: 'x' },
    { speakerKey: 'me', start: 1, end: 2, text: 'y' },
    { speakerKey: 'S0', start: 2, end: 3, text: 'z' },
    { speakerKey: 'S1', start: 3, end: 4, text: 'w' },
  ];
  const matches = new Map([['S0', { uid: 'g', name: 'Gareth', similarity: 0.8 }], ['S1', { uid: null, name: null, similarity: 0 }]]);
  const names = align.displayNames(utt, matches);
  assert.strictEqual(names.get('S1'), 'Speaker 1');
  assert.strictEqual(names.get('S0'), 'Gareth');
  assert.strictEqual(names.get('me'), 'me');
});

// ---------------- speakers store ----------------
test('speakers store: enroll, reinforce, rename, persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pill-spk-'));
  const fakeApp = { getPath: () => dir };
  const speakers = require('../lib/speakers');
  speakers.init(fakeApp);
  const rec = speakers.enroll('Gareth', [1, 0]);
  assert.ok(rec.uid);
  speakers.reinforce(rec.uid, [0, 1], 0.5);
  assert.deepStrictEqual(speakers.get(rec.uid).embedding, [0.5, 0.5]);
  assert.strictEqual(speakers.get(rec.uid).meetings, 2);
  speakers.rename(rec.uid, 'Gareth O.');
  // fresh module instance reads from disk
  delete require.cache[require.resolve('../lib/speakers')];
  const speakers2 = require('../lib/speakers');
  speakers2.init(fakeApp);
  assert.strictEqual(speakers2.get(rec.uid).name, 'Gareth O.');
  assert.strictEqual(speakers2.all().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
