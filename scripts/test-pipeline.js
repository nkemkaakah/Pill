'use strict';
// Integration test: real sidecar.js spawning the mock binary, refine(), the
// session store's applyFinal + renameSpeaker, and roster enrolment — the whole
// post-recording flow minus the Swift binary itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sidecar = require('../lib/sidecar');
const { refine } = require('../lib/refine');
const { WavWriter } = require('../lib/wav');

const bin = path.join(__dirname, 'mock-sidecar.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pill-pipe-'));
const fakeApp = { getPath: () => dir };

const sessions = require('../lib/sessions');
const speakers = require('../lib/speakers');
sessions.init(fakeApp);
speakers.init(fakeApp);

function fakeWav(p, seconds) {
  const w = new WavWriter(p);
  w.append(new Int16Array(16000 * seconds));
  w.finish();
}

(async () => {
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { console.error(`FAIL  ${name}\n      ${err.stack}`); process.exitCode = 1; }
  };

  // Seed the roster with Gareth, whose voiceprint matches mock speaker "1".
  const gareth = speakers.enroll('Gareth', [0.81, 0.09, 0.055]);

  const sess = sessions.create('');
  const meWav = sessions.audioFileFor(sess.id, 'me');
  const themWav = sessions.audioFileFor(sess.id, 'them');
  fakeWav(meWav, 18);
  fakeWav(themWav, 18);

  let result;
  await test('refine: transcribes both channels, diarizes, matches roster', async () => {
    const stages = [];
    result = await refine({
      bin, meWav, themWav,
      roster: speakers.all(),
      onStage: (s) => stages.push(s),
    });
    assert.deepStrictEqual(stages, ['transcribing', 'labelling']);
    assert.strictEqual(result.stats.meWords, 13);
    assert.strictEqual(result.stats.themWords, 12);
    assert.strictEqual(result.stats.voices, 2);
    assert.strictEqual(result.stats.matched, 1);
  });

  await test('refine: timeline interleaves me/them and names are right', async () => {
    const texts = result.utterances.map((u) => `${u.name}: ${u.text}`);
    assert.deepStrictEqual(texts, [
      'Gareth: Walk me through reversing a linked list',
      'me: Sure I would keep a previous pointer',
      'Gareth: And the complexity',
      'me: It is O of n time',
      'Speaker 1: Nice answer',
    ]);
    const g = result.speakers.find((s) => s.name === 'Gareth');
    assert.ok(g.similarity > 0.99, `similarity ${g.similarity}`);
    assert.ok(g.seconds > 3);
    const anon = result.speakers.find((s) => s.name === 'Speaker 1');
    assert.strictEqual(anon.uid, null);
    assert.strictEqual(anon.embedding.length, 3);
  });

  await test('applyFinal replaces the live transcript and persists speakers', async () => {
    sessions.append(sess.id, { t: Date.now(), who: 'them', text: 'live line to be replaced' });
    const saved = sessions.applyFinal(sess.id, result.utterances, result.speakers);
    assert.strictEqual(saved.refined, true);
    assert.strictEqual(saved.entries.length, 5);
    assert.strictEqual(saved.entries[0].name, 'Gareth');
    assert.strictEqual(saved.entries[0].who, 'them');
    assert.strictEqual(saved.entries[1].who, 'me');
    assert.ok(!saved.entries.some((e) => e.text.includes('live line')));
    assert.strictEqual(saved.speakers.length, 2);
    // times are anchored to session start
    assert.ok(saved.entries[0].t >= sess.startedAt);
  });

  await test('renameSpeaker: Speaker 1 -> Karthik updates every line + enrolls voiceprint', async () => {
    const anonKey = result.speakers.find((s) => !s.uid).key;
    // main.js flow: enroll first, then rewrite session
    const rec = speakers.enroll('Karthik', result.speakers.find((s) => s.key === anonKey).embedding);
    const updated = sessions.renameSpeaker(sess.id, anonKey, 'Karthik', rec.uid);
    assert.strictEqual(updated.entries[4].name, 'Karthik');
    assert.strictEqual(updated.speakers.find((s) => s.key === anonKey).name, 'Karthik');
    assert.strictEqual(updated.speakers.find((s) => s.key === anonKey).uid, rec.uid);
  });

  await test('next meeting: Karthik is auto-recognised from the enrolled voiceprint', async () => {
    const again = await refine({ bin, meWav, themWav, roster: speakers.all() });
    const names = again.utterances.map((u) => u.name);
    assert.ok(names.includes('Karthik'), `got ${names}`);
    assert.strictEqual(again.stats.matched, 2);
  });

  await test('reinforce nudges the roster embedding and bumps meeting count', async () => {
    const before = speakers.get(gareth.uid).embedding.slice();
    speakers.reinforce(gareth.uid, [0.9, 0.05, 0.02]);
    const after = speakers.get(gareth.uid);
    assert.notDeepStrictEqual(after.embedding, before);
    assert.strictEqual(after.meetings, 2);
  });

  await test('refine without them-channel still yields a me transcript', async () => {
    const solo = await refine({ bin, meWav, roster: [] });
    assert.strictEqual(solo.utterances.length, 2);
    assert.ok(solo.utterances.every((u) => u.name === 'me'));
    assert.strictEqual(solo.speakers.length, 0);
  });

  await test('refine with no audio at all throws a clear error', async () => {
    await assert.rejects(() => refine({ bin, roster: [] }), /No audio was captured/);
  });

  await test('sidecar: bad exit surfaces stderr tail in the error message', async () => {
    // missing --output -> mock exits 1 with "no output path" on stderr
    await assert.rejects(() => sidecar._run(bin, ['explode', 'x.wav'], { timeoutMs: 5000 }), /exited with code 1[\s\S]*no output path/);
    // unknown command -> mock exits 64
    await assert.rejects(() => sidecar._run(bin, ['explode', 'x.wav', '--output', '/tmp/x.json'], { timeoutMs: 5000 }), /exited with code 64/);
  });

  await test('sidecar: timeout kills the child', async () => {
    const slow = path.join(dir, 'slow.sh');
    fs.writeFileSync(slow, '#!/usr/bin/env bash\nsleep 30\n');
    fs.chmodSync(slow, 0o755);
    const t0 = Date.now();
    await assert.rejects(() => sidecar._run(slow, [], { timeoutMs: 500 }), /timed out/);
    assert.ok(Date.now() - t0 < 5000);
  });

  await test('sidecar.status reports missing binary with guidance', async () => {
    const st = await sidecar.status('/no/such/place/fluidaudiocli');
    assert.strictEqual(st.available, false);
    assert.ok(st.reason.length > 0);
    const st2 = await sidecar.status(bin);
    assert.strictEqual(st2.available, true);
    assert.strictEqual(st2.path, bin);
  });

  await test('session list surfaces refined flag and speaker names', async () => {
    const list = sessions.list();
    const row = list.find((r) => r.id === sess.id);
    assert.strictEqual(row.refined, true);
    assert.ok(row.speakers.includes('Gareth') && row.speakers.includes('Karthik'));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
})();
