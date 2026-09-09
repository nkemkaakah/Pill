'use strict';
// Runs the FluidAudio CLI (the local transcription + diarization engine) as a
// child process. The binary is stock upstream `fluidaudiocli`, built once on
// the Mac by scripts/build-sidecar.sh; we only ever call two subcommands and
// read the JSON files they write:
//
//   fluidaudiocli transcribe <wav> --word-timestamps --output-json <json>
//     -> { text, wordTimings: [{word, startTime, endTime, confidence}], ... }
//   fluidaudiocli process <wav> --mode offline --output <json>
//     -> { segments: [{speakerId, embedding[], startTimeSeconds, endTimeSeconds, qualityScore}], ... }
//
// First run downloads models from HuggingFace; that can take minutes, hence the
// generous timeouts and stderr streaming to onLog.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isMac = process.platform === 'darwin';

/** Candidate locations for the binary, in priority order. */
function candidates(configuredPath) {
  const names = ['fluidaudiocli'];
  const dirs = [];
  if (configuredPath) {
    // A configured path can point at the binary itself or its folder.
    try {
      if (fs.existsSync(configuredPath) && fs.statSync(configuredPath).isDirectory()) dirs.push(configuredPath);
      else return [configuredPath];
    } catch (_) { return [configuredPath]; }
  }
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'sidecar'));
  dirs.push(path.join(__dirname, '..', 'sidecar'));
  dirs.push(path.join(os.homedir(), '.pill'));
  const out = [];
  for (const d of dirs) for (const n of names) out.push(path.join(d, n));
  out.push('fluidaudiocli'); // PATH
  return out;
}

function locate(configuredPath) {
  for (const c of candidates(configuredPath)) {
    try {
      if (c === 'fluidaudiocli') continue; // resolved by spawn via PATH; checked in status()
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function run(bin, args, { timeoutMs, onLog, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env } });
    } catch (err) {
      reject(err);
      return;
    }
    let stderrTail = '';
    const timer = timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`sidecar timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => { if (onLog) onLog(String(d)); });
    child.stderr.on('data', (d) => {
      const s = String(d);
      stderrTail = (stderrTail + s).slice(-4000);
      if (onLog) onLog(s);
    });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`sidecar exited with code ${code}${stderrTail ? `\n${stderrTail.trim().split('\n').slice(-4).join('\n')}` : ''}`));
    });
  });
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function tmpJson(tag) {
  return path.join(os.tmpdir(), `pill-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

/**
 * Batch-transcribe a wav with word timestamps.
 * @returns {Promise<{text:string, words:Array<{word,startTime,endTime,confidence}>}>}
 */
async function transcribe(bin, wavPath, { timeoutMs = 15 * 60 * 1000, onLog } = {}) {
  const out = tmpJson('asr');
  try {
    await run(bin, ['transcribe', wavPath, '--word-timestamps', '--output-json', out], { timeoutMs, onLog });
    const j = readJson(out);
    return { text: j.text || '', words: Array.isArray(j.wordTimings) ? j.wordTimings : [] };
  } finally {
    try { fs.unlinkSync(out); } catch (_) { /* fine */ }
  }
}

/**
 * Offline diarization with per-segment speaker embeddings.
 * @returns {Promise<{segments:Array, speakerCount:number}>}
 */
async function diarize(bin, wavPath, { timeoutMs = 15 * 60 * 1000, onLog } = {}) {
  const out = tmpJson('diar');
  try {
    await run(bin, ['process', wavPath, '--mode', 'offline', '--output', out], { timeoutMs, onLog });
    const j = readJson(out);
    return { segments: Array.isArray(j.segments) ? j.segments : [], speakerCount: j.speakerCount || 0 };
  } finally {
    try { fs.unlinkSync(out); } catch (_) { /* fine */ }
  }
}

/** Cheap availability probe for the settings screen. */
async function status(configuredPath) {
  const bin = locate(configuredPath);
  if (bin) return { available: true, path: bin };
  if (!isMac) return { available: false, reason: 'Local engine runs on macOS only.' };
  return {
    available: false,
    reason: 'fluidaudiocli not found. Run scripts/build-sidecar.sh once, or set the path in settings.',
  };
}

module.exports = { locate, transcribe, diarize, status, _run: run, _candidates: candidates };
