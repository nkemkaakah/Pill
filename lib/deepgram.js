'use strict';
/**
 * Optional cloud pass for the transcript of record (Deepgram Nova-3, pre-recorded).
 *
 * Deliberately only replaces transcription, not diarization: Deepgram returns speaker
 * *labels* but no voice embeddings, and Pill's cross-meeting speaker roster is built
 * from embeddings. So lib/refine.js is given { transcribe: here, diarize: sidecar },
 * keeping FluidAudio for the voiceprints while Deepgram supplies better words.
 *
 * What it buys over the local batch model: punctuation and capitalisation, which the
 * local Parakeet models do not produce at all.
 *
 * Billed per second of audio, per channel. A one-hour two-channel call is ~$0.52 at
 * pay-as-you-go rates, which is why this is opt-in rather than the default.
 */
const fs = require('fs');

const ENDPOINT = 'https://api.deepgram.com/v1/listen';

function describeError(status, body) {
  const hint = {
    400: 'Deepgram rejected the audio.',
    401: 'Deepgram key rejected — check it in Settings.',
    402: 'Deepgram credit exhausted.',
    403: 'This Deepgram key is not allowed to use that model.',
    429: 'Deepgram rate limit hit — try again shortly.',
  }[status];
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j.err_msg || j.error || j.message || '';
  } catch (_) {
    detail = String(body || '').slice(0, 200);
  }
  return `${hint || `Deepgram returned ${status}.`}${detail ? ` (${detail})` : ''}`;
}

/**
 * Same shape as sidecar.transcribe so it can be dropped into refine() unchanged.
 * @returns {Promise<{text:string, words:Array<{word,startTime,endTime,confidence}>}>}
 */
async function transcribe(_bin, wavPath, { apiKey, model = 'nova-3', language = 'en', onLog, signal } = {}) {
  if (!apiKey) throw new Error('No Deepgram key set. Add one in Settings, or use the local engine.');

  const audio = fs.readFileSync(wavPath);
  const params = new URLSearchParams({
    model,
    language,
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  });

  if (onLog) onLog(`deepgram: uploading ${(audio.length / 1024 / 1024).toFixed(1)}MB…`);
  const res = await fetch(`${ENDPOINT}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' },
    body: audio,
    signal,
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text().catch(() => '')));

  const json = await res.json();
  const alt = json
    && json.results
    && json.results.channels
    && json.results.channels[0]
    && json.results.channels[0].alternatives
    && json.results.channels[0].alternatives[0];
  if (!alt) throw new Error('Deepgram returned no transcript for this audio.');

  const words = (alt.words || []).map((w) => ({
    // punctuated_word carries the capitalisation and punctuation, which is the whole
    // reason to pay for this pass; fall back to the bare token if it is absent.
    word: w.punctuated_word || w.word,
    startTime: w.start,
    endTime: w.end,
    confidence: w.confidence,
  }));

  if (onLog) onLog(`deepgram: ${words.length} words over ${json.metadata ? Math.round(json.metadata.duration) : '?'}s`);
  return { text: alt.transcript || '', words };
}

/** Rough pay-as-you-go estimate, so the UI can warn before spending anything. */
function estimateCost(seconds, ratePerMinute = 0.0043) {
  return (seconds / 60) * ratePerMinute;
}

module.exports = { transcribe, estimateCost, _describeError: describeError };
