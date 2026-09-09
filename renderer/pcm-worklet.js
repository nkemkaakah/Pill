// Runs on the audio rendering thread. Accumulates 128-frame render quanta into
// ~4096-sample batches (about 85ms at 48kHz) and posts them to the renderer,
// which resamples to 16kHz and streams them to disk. Mixes input channels to
// mono here so the message traffic stays small.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(4096);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      this.batch[this.fill++] = s / input.length;
      if (this.fill === this.batch.length) {
        this.port.postMessage(this.batch.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
