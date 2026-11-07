// Gom mẫu âm thanh thành khối 100 ms (1600 mẫu @16 kHz), mono, PCM16.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const len = ch[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch.length; c++) s += ch[c][i];
      s = Math.max(-1, Math.min(1, s / ch.length));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
