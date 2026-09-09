'use strict';
// The post-recording refinement pipeline. Takes the two raw WAVs a session
// recorded, runs the local engine (transcribe + diarize), aligns words to
// speakers, matches voices against the saved roster, and returns the final
// labelled transcript. Pure orchestration — injectable sidecar for tests.

const fs = require('fs');
const defaultSidecar = require('./sidecar');
const align = require('./align');

function hasAudio(wavPath, minBytes = 44 + 16000) { // > ~0.5s of 16k mono int16
  try {
    return fs.statSync(wavPath).size >= minBytes;
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.bin           path to fluidaudiocli
 * @param {string} [opts.meWav]       mic channel wav
 * @param {string} [opts.themWav]     system-audio channel wav
 * @param {Array}  [opts.roster]      saved speakers [{uid,name,embedding}]
 * @param {number} [opts.threshold]   cosine match threshold
 * @param {(stage:string)=>void} [opts.onStage]
 * @param {(line:string)=>void}  [opts.onLog]
 * @param {object} [opts.sidecar]     injectable {transcribe, diarize}
 * @returns {Promise<{utterances:Array, speakers:Array, stats:object}>}
 *   utterances: [{key, name, start, end, text}]
 *   speakers:   [{key, name, uid, similarity, seconds, embedding}]  ('them' voices only)
 */
async function refine(opts) {
  const sidecar = opts.sidecar || defaultSidecar;
  const onStage = opts.onStage || (() => {});
  const onLog = opts.onLog;
  const roster = opts.roster || [];

  const meOk = opts.meWav && hasAudio(opts.meWav);
  const themOk = opts.themWav && hasAudio(opts.themWav);
  if (!meOk && !themOk) throw new Error('No audio was captured in this session.');

  onStage('transcribing');
  const jobs = {
    meWords: meOk ? sidecar.transcribe(opts.bin, opts.meWav, { onLog }) : Promise.resolve({ words: [] }),
    themWords: themOk ? sidecar.transcribe(opts.bin, opts.themWav, { onLog }) : Promise.resolve({ words: [] }),
    diar: themOk ? sidecar.diarize(opts.bin, opts.themWav, { onLog }) : Promise.resolve({ segments: [] }),
  };
  const [meRes, themRes, diarRes] = await Promise.all([jobs.meWords, jobs.themWords, jobs.diar]);

  onStage('labelling');
  const meUtt = align.wordsToUtterances(meRes.words, 'me');
  const themUtt = themRes.words.length
    ? (diarRes.segments.length
      ? align.alignWordsToSegments(themRes.words, diarRes.segments)
      : align.wordsToUtterances(themRes.words, 'them'))
    : [];

  const voiceprints = align.speakerVoiceprints(diarRes.segments);
  const matches = align.matchSpeakers(voiceprints, roster, { threshold: opts.threshold ?? 0.45 });

  const merged = align.mergeTimelines(meUtt, themUtt);
  const names = align.displayNames(merged, matches);
  const utterances = merged.map((u) => ({ ...u, name: names.get(u.speakerKey) || u.speakerKey, key: u.speakerKey }))
    .map(({ speakerKey, ...rest }) => rest);

  const speakers = [];
  for (const [key, vp] of voiceprints) {
    const m = matches.get(key) || { uid: null, name: null, similarity: 0 };
    speakers.push({
      key,
      name: names.get(key) || key,
      uid: m.uid,
      similarity: m.similarity,
      seconds: Math.round(vp.seconds * 10) / 10,
      embedding: vp.embedding,
    });
  }
  speakers.sort((a, b) => b.seconds - a.seconds);

  return {
    utterances,
    speakers,
    stats: {
      meWords: meRes.words.length,
      themWords: themRes.words.length,
      segments: diarRes.segments.length,
      voices: voiceprints.size,
      matched: speakers.filter((s) => s.uid).length,
    },
  };
}

module.exports = { refine, hasAudio };
