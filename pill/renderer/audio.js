/* global window */
// Two independent channels:
//   "me"   -> getUserMedia (microphone)
//   "them" -> getDisplayMedia with loopback audio (whatever the Mac is playing: Zoom, Meet, YouTube...)
// Each channel is cut into standalone webm/opus clips every N seconds and handed to the
// main process for transcription. Silent clips are dropped before they cost anything.

(function () {
  const MIME = 'audio/webm;codecs=opus';

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

    stop() {
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
