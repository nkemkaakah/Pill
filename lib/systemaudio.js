'use strict';
/**
 * System-audio capture via Core Audio process taps (the `audiotee` sidecar).
 *
 * Replaces getDisplayMedia({audio:'loopback'}), which Electron only supports on
 * Windows — on macOS it returns a video-only stream and the audio track never
 * exists. Taps sit at the HAL, below the window server, so they also catch apps
 * that render audio from a windowless helper process (FaceTime, Continuity, and
 * by extension WhatsApp), which ScreenCaptureKit cannot see.
 *
 * Emits 16 kHz mono pcm_s16le — byte-identical to what lib/wav.js writes, so the
 * buffers go straight to appendPcm with no conversion.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// The tap's audio device takes ~2.5s to spin up after the process starts, so
// first bytes arrive well after launch. Anything past this and it is not coming.
const FIRST_DATA_TIMEOUT_MS = 12000;
// No buffers at all for this long means the tap died even though the process lives.
const STALL_MS = 5000;
// All-digital-silence for this long is reported as advice, not failure: it is
// exactly what a working tap produces when nothing is playing.
const QUIET_MS = 45000;
// Bluetooth handoff (AirPods -> hands-free when the mic opens) can leave the output
// device's format unreadable for a beat, which kills audiotee outright.
const START_ATTEMPTS = 4;
const RETRY_DELAY_MS = 900;

function candidates(configured) {
  const out = [];
  if (configured) out.push(configured);
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'audiotee', 'audiotee'));
  out.push(path.join(__dirname, '..', 'node_modules', 'audiotee', 'bin', 'audiotee'));
  return out;
}

function locate(configured) {
  for (const p of candidates(configured)) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

/** Peak amplitude of an s16le buffer, 0..1. Cheap enough to run on every chunk. */
function peakOf(buf) {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak / 32768;
}

class SystemAudio extends EventEmitter {
  constructor({
    binaryPath = '',
    sampleRate = 16000,
    chunkSeconds = 0.2,
    firstDataTimeoutMs = FIRST_DATA_TIMEOUT_MS,
    stallMs = STALL_MS,
    quietMs = QUIET_MS,
    startAttempts = START_ATTEMPTS,
    retryDelayMs = RETRY_DELAY_MS,
  } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.sampleRate = sampleRate;
    this.chunkSeconds = chunkSeconds;
    this.firstDataTimeoutMs = firstDataTimeoutMs;
    this.stallMs = stallMs;
    this.quietMs = quietMs;
    this.startAttempts = startAttempts;
    this.retryDelayMs = retryDelayMs;
    this.proc = null;
    this.active = false;
    this.lastDataAt = 0;
    this.lastSoundAt = 0;
    this.quietWarned = false;
    this.timers = [];
    this.stderrTail = [];
  }

  isActive() { return this.active; }

  /**
   * Node throws on an 'error' event with no listener, which would take the whole
   * Electron main process down over a failed audio tap. Never worth that.
   */
  emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[pill] system audio:', err.message);
  }

  /**
   * Bluetooth output devices renegotiate when the mic opens (AirPods switching to
   * hands-free), and the device's stream format is briefly unreadable while that
   * happens — audiotee hits a Swift fatal error and dies with SIGTRAP. It is transient,
   * so retry a few times before giving up and telling the user.
   */
  async start() {
    if (this.active) return;
    let lastErr = null;
    for (let attempt = 1; attempt <= this.startAttempts; attempt++) {
      try {
        await this.attemptStart();
        return;
      } catch (err) {
        lastErr = err;
        const transient = /stream format|device format|SIGTRAP|Core Audio subsystem/i.test(err.message);
        if (!transient || attempt === this.startAttempts) break;
        this.emit('log', { level: 'info', text: `audio device busy (attempt ${attempt}) — retrying` });
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    throw lastErr;
  }

  /**
   * One launch attempt. Resolves only once real audio bytes have arrived —
   * `stream_start` on stderr fires ~2.5s before the device actually runs, so it is
   * not a usable readiness signal; first data is.
   */
  attemptStart() {
    const bin = locate(this.binaryPath);
    if (!bin) {
      return Promise.reject(new Error('audiotee binary not found — system audio cannot be captured.'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(err);
      };

      const args = ['--sample-rate', String(this.sampleRate), '--chunk-duration', String(this.chunkSeconds)];
      // No --include-processes: an empty filter taps every process, which is what
      // catches call apps that play audio from a helper PID. Do not narrow this.
      this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc.on('error', (err) => fail(new Error(`audiotee failed to start: ${err.message}`)));

      this.proc.on('exit', (code, signal) => {
        const wasActive = this.active;
        this.active = false;
        this.clearTimers();
        if (!settled) {
          fail(new Error(`audiotee exited during startup (code ${code}${signal ? `, ${signal}` : ''}): ${this.stderrTail.join(' ').slice(-300)}`));
        } else if (wasActive) {
          this.emitError(new Error(`System audio capture stopped unexpectedly (code ${code}${signal ? `, ${signal}` : ''}).`));
        }
        this.emit('stopped');
      });

      this.proc.stdout.on('data', (buf) => {
        const now = Date.now();
        this.lastDataAt = now;
        if (peakOf(buf) > 0) {
          this.lastSoundAt = now;
          if (this.quietWarned) {
            this.quietWarned = false;
            this.emit('recovered');
          }
        }
        if (!settled) {
          settled = true;
          this.active = true;
          this.lastSoundAt = now; // don't fire a quiet warning before any chance to speak
          this.startWatchdogs();
          this.emit('started');
          resolve();
        }
        this.emit('data', buf);
      });

      this.readStderr();

      this.timers.push(setTimeout(() => {
        fail(new Error(`audiotee produced no audio within ${Math.round(this.firstDataTimeoutMs/1000)}s. Check System Settings → Privacy & Security → Screen & System Audio Recording.`));
      }, this.firstDataTimeoutMs));
    });
  }

  /** audiotee reports structured NDJSON on stderr — unlike fluidaudiocli, which logs to OSLog only. */
  readStderr() {
    let buf = '';
    this.proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        let msg = null;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        const level = msg.message_type;
        const text = (msg.data && msg.data.message) || '';
        // Only raise once we are actually running. During startup the error is carried
        // by the rejection instead, so a failure we go on to retry past never flashes a
        // red banner at the user for a problem that fixed itself.
        if (level === 'error' && this.active) this.emitError(new Error(text || 'audiotee reported an error'));
        else this.emit('log', { level, text, context: msg.data && msg.data.context });
      }
    });
  }

  startWatchdogs() {
    this.timers.push(setInterval(() => {
      const now = Date.now();
      if (this.lastDataAt && now - this.lastDataAt > this.stallMs) {
        this.emitError(new Error('System audio capture stalled — no data from the tap.'));
        this.stop();
        return;
      }
      // Digital silence is normal when nothing is playing, so this is advice.
      // It is also the warning that would have surfaced the 44-byte them.wav.
      if (!this.quietWarned && this.lastSoundAt && now - this.lastSoundAt > this.quietMs) {
        this.quietWarned = true;
        this.emit('quiet', Math.round((now - this.lastSoundAt) / 1000));
      }
    }, Math.max(50, Math.min(1000, this.stallMs / 2, this.quietMs / 2))));
  }

  clearTimers() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  stop() {
    this.clearTimers();
    this.active = false;
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      p.stdout.removeAllListeners('data');
      p.kill('SIGTERM'); // audiotee shuts the tap down gracefully on SIGTERM
    } catch (_) { /* already gone */ }
  }
}

module.exports = { SystemAudio, locate, peakOf };
