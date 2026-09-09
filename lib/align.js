'use strict';
// Pure functions that turn sidecar output into a speaker-labelled transcript
// and match voices across sessions. No IO — everything here is unit-tested.
//
// Inputs (shapes come from FluidAudio's CLI, verified against its source):
//   words:    [{ word, startTime, endTime, confidence }]           (transcribe --word-timestamps --output-json)
//   segments: [{ speakerId, embedding[], startTimeSeconds, endTimeSeconds, qualityScore }]  (process --mode offline)

/** Cosine similarity of two equal-length vectors. 0 when degenerate. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * One averaged voiceprint per diarized speaker, weighted by segment duration ×
 * quality so long confident turns dominate over half-second interjections.
 * @returns {Map<string, {embedding:number[], seconds:number}>}
 */
function speakerVoiceprints(segments) {
  const acc = new Map();
  for (const s of segments) {
    if (!Array.isArray(s.embedding) || !s.embedding.length) continue;
    const dur = Math.max(0, (s.endTimeSeconds ?? 0) - (s.startTimeSeconds ?? 0));
    const q = Number.isFinite(s.qualityScore) && s.qualityScore > 0 ? s.qualityScore : 0.5;
    const w = dur * q;
    if (w <= 0) continue;
    let entry = acc.get(s.speakerId);
    if (!entry) {
      entry = { sum: new Float64Array(s.embedding.length), weight: 0, seconds: 0 };
      acc.set(s.speakerId, entry);
    }
    if (entry.sum.length !== s.embedding.length) continue; // malformed mix, skip
    for (let i = 0; i < s.embedding.length; i++) entry.sum[i] += s.embedding[i] * w;
    entry.weight += w;
    entry.seconds += dur;
  }
  const out = new Map();
  for (const [id, e] of acc) {
    if (e.weight <= 0) continue;
    out.set(id, { embedding: Array.from(e.sum, (v) => v / e.weight), seconds: e.seconds });
  }
  return out;
}

/**
 * Assign each transcribed word to the diarized speaker whose segments overlap it
 * most; then group consecutive same-speaker words into utterances.
 * Words that overlap no segment stick with the previous utterance when one is
 * close (< gapTolerance), otherwise they open an 'unknown' utterance.
 *
 * @returns {Array<{speakerKey:string, start:number, end:number, text:string}>}
 */
function alignWordsToSegments(words, segments, { gapTolerance = 1.5 } = {}) {
  const segs = [...segments].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  function speakerAt(w) {
    let best = null;
    let bestOverlap = 0;
    for (const s of segs) {
      if (s.startTimeSeconds >= w.endTime + gapTolerance) break;
      const overlap = Math.min(w.endTime, s.endTimeSeconds) - Math.max(w.startTime, s.startTimeSeconds);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = s.speakerId;
      }
    }
    if (best) return best;
    // No direct overlap: nearest segment edge within tolerance.
    let nearest = null;
    let nearestGap = gapTolerance;
    for (const s of segs) {
      const gap = w.startTime > s.endTimeSeconds
        ? w.startTime - s.endTimeSeconds
        : s.startTimeSeconds - w.endTime;
      if (gap >= 0 && gap < nearestGap) {
        nearestGap = gap;
        nearest = s.speakerId;
      }
    }
    return nearest || 'unknown';
  }

  const utterances = [];
  for (const w of words) {
    const word = String(w.word || '').trim();
    if (!word) continue;
    const key = speakerAt(w);
    const last = utterances[utterances.length - 1];
    if (last && last.speakerKey === key && w.startTime - last.end <= gapTolerance + 2) {
      last.text += ` ${word}`;
      last.end = Math.max(last.end, w.endTime);
    } else {
      utterances.push({ speakerKey: key, start: w.startTime, end: w.endTime, text: word });
    }
  }
  return utterances;
}

/** Turn the me-channel words into utterances split on silence gaps. */
function wordsToUtterances(words, speakerKey, { splitGap = 2.0 } = {}) {
  const out = [];
  for (const w of words) {
    const word = String(w.word || '').trim();
    if (!word) continue;
    const last = out[out.length - 1];
    if (last && w.startTime - last.end <= splitGap) {
      last.text += ` ${word}`;
      last.end = Math.max(last.end, w.endTime);
    } else {
      out.push({ speakerKey, start: w.startTime, end: w.endTime, text: word });
    }
  }
  return out;
}

/** Interleave utterance lists by start time. */
function mergeTimelines(...lists) {
  return lists.flat().sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Match this session's anonymous voiceprints against the saved roster.
 * Greedy best-match-first, one known speaker per anonymous voice.
 *
 * @param {Map<string,{embedding:number[],seconds:number}>} voiceprints
 * @param {Array<{uid:string,name:string,embedding:number[]}>} known
 * @returns {Map<string,{uid:string|null,name:string|null,similarity:number}>}
 */
function matchSpeakers(voiceprints, known, { threshold = 0.45 } = {}) {
  const pairs = [];
  for (const [speakerId, vp] of voiceprints) {
    for (const k of known) {
      const sim = cosine(vp.embedding, k.embedding);
      if (sim >= threshold) pairs.push({ speakerId, uid: k.uid, name: k.name, sim });
    }
  }
  pairs.sort((a, b) => b.sim - a.sim);
  const out = new Map();
  const usedKnown = new Set();
  for (const p of pairs) {
    if (out.has(p.speakerId) || usedKnown.has(p.uid)) continue;
    out.set(p.speakerId, { uid: p.uid, name: p.name, similarity: p.sim });
    usedKnown.add(p.uid);
  }
  for (const speakerId of voiceprints.keys()) {
    if (!out.has(speakerId)) out.set(speakerId, { uid: null, name: null, similarity: 0 });
  }
  return out;
}

/**
 * Stable display keys for a session: matched voices get their saved name,
 * unmatched ones get Speaker 1, Speaker 2… ordered by first appearance.
 */
function displayNames(utterances, matches) {
  const names = new Map(); // speakerKey -> display
  let n = 0;
  for (const u of utterances) {
    if (names.has(u.speakerKey)) continue;
    if (u.speakerKey === 'me') { names.set('me', 'me'); continue; }
    if (u.speakerKey === 'unknown') { names.set('unknown', 'unknown'); continue; }
    const m = matches && matches.get(u.speakerKey);
    if (m && m.name) names.set(u.speakerKey, m.name);
    else names.set(u.speakerKey, `Speaker ${++n}`);
  }
  return names;
}

module.exports = {
  cosine, speakerVoiceprints, alignWordsToSegments, wordsToUtterances,
  mergeTimelines, matchSpeakers, displayNames,
};
