/* global window */
// Microphone capture only. The mic is tapped through an AudioWorklet and the raw
// float samples are handed to preload, which resamples to 16 kHz Int16 and forwards
// them to the main process for the WAV file and the live recogniser.
//
// The "them" channel is not here: it used getDisplayMedia loopback audio, which
// Electron supports on Windows only, so on macOS it produced silence for every meeting
// ever recorded. System audio is now a Core Audio process tap in the main process
// (lib/systemaudio.js). This file keeps only what a renderer is actually needed for —
// the mic, which the main process cannot open itself.

(function () {
  class Channel {
    constructor(who, stream, ctx, opts) {
      this.who = who;
      this.stream = stream;
      this.ctx = ctx;
      this.opts = opts;
      this.running = false;
      this.level = 0;
      this.peak = 0;

      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);

      // worklet -> preload (resample + Int16 + batch) -> main, which writes
      // <session>.<who>.wav and feeds the same bytes to the live recogniser.
      this.tap = null;
      if (opts.wavCapture && ctx.audioWorklet && window.pill && window.pill.sendPcmFloat) {
        try {
          this.tap = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfOutputs: 0 });
          window.pill.resetPcm(this.who);
          const rate = ctx.sampleRate;
          this.tap.port.onmessage = (e) => {
            if (!this.running) return;
            // Resampling, Int16 conversion and batching all live in preload, against
            // the same unit-tested code the WAV writer uses.
            window.pill.sendPcmFloat(this.who, e.data.buffer, rate);
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
      // The old MediaRecorder cycle lived here: a fresh recorder every
      // cfg.chunkSeconds, each clip POSTed to OpenAI. It made 6s the floor latency by
      // construction and cut words at every boundary. The PCM tap above now feeds a
      // local streaming recogniser in the main process instead, so there is nothing
      // to start beyond the tap itself.
    }

    stopTap() {
      if (!this.tap) return;
      try { this.tap.port.onmessage = null; this.tap.disconnect(); } catch (_) { /* fine */ }
      this.tap = null;
    }

    stop() {
      this.stopTap();
      this.running = false;
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
          audio: {
            // Keeps the far end (playing out of the speakers) from being picked up here
            // and transcribed a second time as you. Verified not to affect the system
            // tap, which sits below VoiceProcessingIO.
            echoCancellation: true,
            noiseSuppression: true,
            // AGC off on purpose: it rides the gain up during pauses and pushed every
            // mic recording to peak 1.0, so the recogniser never saw a silence gap and
            // utterances were never closed.
            autoGainControl: false,
          },
          video: false,
        });
        this.channels.me = new Channel('me', mic, this.ctx, this.opts);
        this.channels.me.start();
        result.me = true;
      } catch (err) {
        result.errors.push(`Mic: ${err.message}`);
      }

      // The "them" channel is no longer captured here. getDisplayMedia's 'loopback'
      // audio is Windows-only in Electron, so this branch silently produced nothing on
      // macOS for every meeting. System audio now comes from a Core Audio process tap
      // owned by the main process (lib/systemaudio.js), which reports its own status
      // over capture:status.
      result.them = 'main';

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
