/* global window */
// Two independent channels:
//   "me"   -> getUserMedia (microphone)
//   "them" -> getDisplayMedia with loopback audio (whatever the Mac is playing: Zoom, Meet, YouTube...)
// Each channel is cut into standalone webm/opus clips every N seconds and handed to the
// main process for transcription. Silent clips are dropped before they cost anything.

(function () {
  const MIME = 'audio/webm;codecs=opus';
  const TARGET_RATE = 16000;

  // Mirror of lib/wav.js Resampler/floatToInt16 (unit-tested there); the
  // renderer can't require Node modules, so the ~30 lines live here too.
  class Resampler {
    constructor(fromRate, toRate = TARGET_RATE) {
      this.ratio = fromRate / toRate;
      this.pos = 0;
      this.prev = 0;
      this.hasPrev = false;
    }

    process(input) {
      if (!input.length) return new Float32Array(0);
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
      this.prev = input[input.length - 1];
      this.hasPrev = true;
      this.pos = pos - (avail - 1);
      return Float32Array.from(out);
    }
  }

  function floatToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  class Channel {
    constructor(who, stream, ctx, opts) {
      this.who = who;
      this.stream = stream;
      this.ctx = ctx;
      this.opts = opts;
      this.running = false;
      this.level = 0;
      this.peak = 0;
      this.recorder = null;
      this.timer = null;

      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);

      // Archival tap: raw PCM -> worklet -> resample to 16k -> Int16 -> main
      // process, which streams it into <session>.<who>.wav for the local
      // engine. Independent of the chunked live-transcription cycle below.
      this.tap = null;
      if (opts.wavCapture && ctx.audioWorklet && window.pill && window.pill.sendPcm) {
        try {
          this.tap = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfOutputs: 0 });
          const resampler = new Resampler(ctx.sampleRate);
          let pending = [];
          let pendingLen = 0;
          this.tap.port.onmessage = (e) => {
            if (!this.running) return;
            const i16 = floatToInt16(resampler.process(e.data));
            if (!i16.length) return;
            pending.push(i16);
            pendingLen += i16.length;
            if (pendingLen >= TARGET_RATE / 2) { // flush ~every 0.5s
              const merged = new Int16Array(pendingLen);
              let off = 0;
              for (const part of pending) { merged.set(part, off); off += part.length; }
              pending = [];
              pendingLen = 0;
              window.pill.sendPcm(this.who, merged.buffer);
            }
          };
          src.connect(this.tap);
        } catch (err) {
          this.tap = null;
          console.warn(`[pill] pcm tap unavailable for ${who}: ${err.message}`);
        }
      }
    }

    sample() {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      this.level = rms;
      if (rms > this.peak) this.peak = rms;
      return rms;
    }

    start() {
      this.running = true;
      this.cycle();
    }

    cycle() {
      if (!this.running) return;
      const chunks = [];
      let rec;
      try {
        rec = new MediaRecorder(this.stream, { mimeType: MIME, audioBitsPerSecond: 48000 });
      } catch (err) {
        this.opts.onError(this.who, `Recorder failed: ${err.message}`);
        this.running = false;
        return;
      }
      this.recorder = rec;
      this.peak = 0;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        const peak = this.peak;
        if (this.running) this.cycle(); // start the next clip immediately, no gap
        if (!chunks.length) return;
        if (peak < this.opts.silenceGate()) return; // nothing worth transcribing
        const blob = new Blob(chunks, { type: MIME });
        const buffer = await blob.arrayBuffer();
        this.opts.onChunk(this.who, buffer, MIME);
      };
      rec.start();
      this.timer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, this.opts.chunkMs());
    }

    stopTap() {
      if (!this.tap) return;
      try { this.tap.port.onmessage = null; this.tap.disconnect(); } catch (_) { /* fine */ }
      this.tap = null;
    }

    stop() {
      this.stopTap();
      this.running = false;
      clearTimeout(this.timer);
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      this.stream.getTracks().forEach((t) => t.stop());
    }
  }

  class Listener {
    constructor(opts) {
      this.opts = opts;
      this.ctx = null;
      this.channels = {};
      this.meterTimer = null;
    }

    get active() { return Object.keys(this.channels).length > 0; }

    async start() {
      if (this.active) return { me: true, them: !!this.channels.them };
      this.ctx = this.ctx || new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.workletReady) {
        try {
          await this.ctx.audioWorklet.addModule('pcm-worklet.js');
          this.workletReady = true;
        } catch (err) {
          console.warn(`[pill] pcm worklet failed to load: ${err.message}`);
          this.workletReady = false;
        }
      }
      this.opts.wavCapture = this.workletReady !== false;
      const result = { me: false, them: false, errors: [] };

      // Mic
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        this.channels.me = new Channel('me', mic, this.ctx, this.opts);
        this.channels.me.start();
        result.me = true;
      } catch (err) {
        result.errors.push(`Mic: ${err.message}`);
      }

      // System audio (loopback). Main hands back a screen source + 'loopback' audio;
      // we drop the video track straight away and keep only the audio.
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        sys.getVideoTracks().forEach((t) => t.stop());
        const audioOnly = new MediaStream(sys.getAudioTracks());
        if (!audioOnly.getAudioTracks().length) throw new Error('no system audio track (needs macOS 13+ and Screen Recording permission)');
        this.channels.them = new Channel('them', audioOnly, this.ctx, this.opts);
        this.channels.them.start();
        result.them = true;
      } catch (err) {
        result.errors.push(`System audio: ${err.message}`);
      }

      if (this.active) {
        this.meterTimer = setInterval(() => {
          let lvl = 0;
          for (const ch of Object.values(this.channels)) lvl = Math.max(lvl, ch.sample());
          this.opts.onLevel(lvl);
        }, 50);
      }
      return result;
    }

    stop() {
      clearInterval(this.meterTimer);
      for (const ch of Object.values(this.channels)) ch.stop();
      this.channels = {};
      this.opts.onLevel(0);
    }
  }

  window.PillAudio = { Listener };
})();
