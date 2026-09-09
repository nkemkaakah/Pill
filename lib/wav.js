'use strict';
// Streaming 16 kHz mono 16-bit WAV writer + incremental resampler.
//
// The renderer captures Float32 PCM at the AudioContext rate (usually 48 kHz),
// resamples it to 16 kHz with Resampler, converts to Int16, and streams it here.
// WavWriter appends to the file as data arrives and patches the RIFF sizes on
// finish, so a crash mid-meeting still leaves a mostly-valid file (fixable by
// rewriting the header) and memory stays flat no matter how long the meeting is.

const fs = require('fs');

const SAMPLE_RATE = 16000;

/** Build a 44-byte PCM WAV header. dataBytes may be a placeholder. */
function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);          // fmt chunk size
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

class WavWriter {
  constructor(filePath, sampleRate = SAMPLE_RATE) {
    this.path = filePath;
    this.sampleRate = sampleRate;
    this.dataBytes = 0;
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, wavHeader(0, sampleRate));
  }

  /** @param {Buffer|Int16Array} chunk Int16 PCM samples */
  append(chunk) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    fs.writeSync(this.fd, buf);
    this.dataBytes += buf.length;
  }

  get seconds() {
    return this.dataBytes / 2 / this.sampleRate;
  }

  /** Patch sizes and close. Returns {path, seconds, bytes}. */
  finish() {
    const header = wavHeader(this.dataBytes, this.sampleRate);
    fs.writeSync(this.fd, header, 0, 44, 0);
    fs.closeSync(this.fd);
    return { path: this.path, seconds: this.seconds, bytes: this.dataBytes + 44 };
  }
}

/**
 * Incremental linear-interpolation resampler, Float32 in → Float32 out.
 * Keeps one sample of history so chunk boundaries are seamless. Linear
 * interpolation is plenty for 48k→16k speech feeding an ASR model.
 */
class Resampler {
  constructor(fromRate, toRate = SAMPLE_RATE) {
    this.ratio = fromRate / toRate;
    this.pos = 0;        // fractional read position within the virtual input stream
    this.prev = 0;       // last sample of the previous chunk
    this.hasPrev = false;
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  process(input) {
    if (!input.length) return new Float32Array(0);
    // Virtual stream: [prev, ...input]; positions <1 interpolate prev→input[0].
    const avail = (this.hasPrev ? 1 : 0) + input.length;
    const out = [];
    let pos = this.pos;
    while (pos <= avail - 1 - 1e-9) {
      const i = Math.floor(pos);
      const frac = pos - i;
      let s0, s1;
      if (this.hasPrev) {
        s0 = i === 0 ? this.prev : input[i - 1];
        s1 = input[i];
      } else {
        s0 = input[i];
        s1 = input[i + 1];
      }
      out.push(s0 + (s1 - s0) * frac);
      pos += this.ratio;
    }
    // Rebase so next chunk's virtual stream is [lastSample, ...next]
    this.prev = input[input.length - 1];
    this.hasPrev = true;
    this.pos = pos - (avail - 1);
    return Float32Array.from(out);
  }
}

/** Float32 [-1,1] → Int16, with clipping. */
function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Average multi-channel Float32 planes into mono. */
function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Parse a small WAV file (tests + sanity checks). */
function readWav(filePath) {
  const b = fs.readFileSync(filePath);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  const sampleRate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  const dataBytes = b.readUInt32LE(40);
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(44 + i * 2);
  return { sampleRate, channels, bits, dataBytes, samples };
}

module.exports = { SAMPLE_RATE, WavWriter, Resampler, floatToInt16, mixToMono, wavHeader, readWav };
