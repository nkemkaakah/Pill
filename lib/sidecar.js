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
const { EventEmitter } = require('events');
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
    // v2 is the English-only model and beats multilingual v3 on English meeting audio;
    // without --language the model auto-detects, which garbles short noisy segments.
    await run(bin, ['transcribe', wavPath, '--word-timestamps', '--model-version', 'v2', '--language', 'en', '--output-json', out], { timeoutMs, onLog });
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

/**
 * One long-lived `fluidaudiocli parakeet-stream` process per channel, fed raw PCM on
 * stdin and emitting NDJSON on stdout.
 *
 * `run()` above cannot do this: it is promise-per-process, has no stdin, and treats
 * stdout as log text. The stock `parakeet-eou` subcommand cannot either — it is
 * file-in/blob-out, so live use would mean re-spawning per utterance and paying model
 * load every time. `parakeet-stream` is added to the vendored CLI for exactly this.
 *
 * Events: 'ready' | 'partial' (text) | 'final' (text) | 'log' (line) | 'error' (Error)
 */
class StreamingSidecar extends EventEmitter {
  constructor({ bin, chunkMs = 320, eouDebounceMs = 1280, stableMs = 1500, readyTimeoutMs = 10 * 60 * 1000 } = {}) {
    super();
    this.bin = bin;
    this.chunkMs = chunkMs;
    this.eouDebounceMs = eouDebounceMs;
    this.stableMs = stableMs;
    this.readyTimeoutMs = readyTimeoutMs; // first run downloads models; be patient
    this.proc = null;
    this.ready = false;
    this.stderrTail = [];
  }

  /** Same guard as SystemAudio: an unhandled 'error' would kill the main process. */
  emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[pill] streaming engine:', err.message);
  }

  start() {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const args = [
        'parakeet-stream',
        '--chunk-ms', String(this.chunkMs),
        '--eou-debounce-ms', String(this.eouDebounceMs),
        '--stable-ms', String(this.stableMs),
      ];
      this.proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      // A dead reader on stdin would otherwise throw EPIPE up through appendPcm.
      this.proc.stdin.on('error', () => { /* handled via exit */ });

      this.proc.on('error', (err) => {
        if (!settled) { settled = true; reject(new Error(`streaming engine failed to start: ${err.message}`)); }
      });

      this.proc.on('exit', (code, signal) => {
        const was = this.ready;
        this.ready = false;
        this.proc = null;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`streaming engine exited (code ${code}${signal ? `, ${signal}` : ''}): ${this.stderrTail.join(' ').slice(-300)}`));
        } else if (was) {
          this.emitError(new Error(`Live transcription stopped unexpectedly (code ${code}${signal ? `, ${signal}` : ''}).`));
        }
      });

      let out = '';
      this.proc.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const lines = out.split('\n');
        out = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (msg.type === 'ready') {
            this.ready = true;
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
            this.emit('ready');
          } else if (msg.type === 'partial') this.emit('partial', msg.text || '');
          else if (msg.type === 'final') this.emit('final', msg.text || '');
          else if (msg.type === 'error') this.emitError(new Error(msg.message || 'streaming engine error'));
        }
      });

      // parakeet-stream writes diagnostics to stderr on purpose; every other
      // subcommand logs to OSLog only, which a spawned child cannot see at all.
      let errBuf = '';
      this.proc.stderr.on('data', (chunk) => {
        errBuf += chunk.toString();
        const lines = errBuf.split('\n');
        errBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) this.stderrTail.shift();
          this.emit('log', line);
        }
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error('streaming engine did not become ready in time (first run downloads models).'));
      }, this.readyTimeoutMs);
    });
  }

  write(buf) {
    if (!this.proc || !this.ready || !this.proc.stdin.writable) return;
    try { this.proc.stdin.write(buf); } catch (_) { /* exit handler reports it */ }
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    if (!p) return;
    try { p.stdin.end(); } catch (_) { /* already closed */ }
    // Closing stdin makes it flush a final utterance and exit; SIGTERM is the backstop.
    setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) { /* gone */ } }, 2000);
  }
}

module.exports = { locate, transcribe, diarize, status, StreamingSidecar, _run: run, _candidates: candidates };
