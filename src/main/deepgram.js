// Nhận dạng giọng nói bằng Deepgram Flux (đám mây, streaming). Flux tự phát hiện HẾT LƯỢT NÓI bằng model
// (không chỉ dựa vào im lặng), và báo sớm "có vẻ sắp hết lượt" (EagerEndOfTurn) để app dịch đoán trước.
// Tài liệu: https://developers.deepgram.com/docs/flux/quickstart , /docs/flux/state
//
// Lớp này đổi sự kiện của Flux sang cùng dạng tin nhắn mà sidecar Whisper/Nemotron gửi, để main.js xử lý chung:
//   speech  : bắt đầu có người nói
//   interim : chữ tạm (chỉ gửi khi chữ đổi)
//   pause   : Flux nghĩ có thể đã hết lượt (EagerEndOfTurn) -> dịch đoán trước
//   resume  : họ nói tiếp (TurnResumed) -> bỏ bản đoán trước
//   final   : hết lượt (EndOfTurn), kèm end_of_turn: true
//   dropped : hết lượt nhưng không có chữ
const WebSocket = require('ws');

const URL_BASE = 'wss://api.deepgram.com/v2/listen';

function buildUrl({ model = 'flux-general-en', eagerEot = 0.5, eotThreshold = 0.7, eotTimeoutMs = 5000, keyterms = [] }) {
  const q = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: '16000',
    eot_threshold: String(eotThreshold),
    eot_timeout_ms: String(eotTimeoutMs),
  });
  if (eagerEot) q.set('eager_eot_threshold', String(eagerEot));
  // keyterm: lặp lại tham số cho từng cụm (không nối bằng dấu phẩy — API sẽ coi cả chuỗi là một cụm).
  for (const k of keyterms.slice(0, 100)) q.append('keyterm', k);
  return `${URL_BASE}?${q.toString()}`;
}

// "Kong, Acme Corp; Nguyen Van A" -> ["Kong", "Acme Corp", "Nguyen Van A"]
const parseKeyterms = (glossary) =>
  (glossary || '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

class DeepgramFlux {
  /**
   * @param {object} o
   * @param {string} o.key        API key Deepgram
   * @param {(msg: object) => void} o.onMessage  nhận tin nhắn dạng sidecar
   * @param {(state: string, info?: object) => void} [o.onState]  'open' | 'closed' | 'error'
   * @param {number} [o.idBase]   số id bắt đầu cho các đoạn
   */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.id = o.idBase || 100000;
    this.turnText = '';
    this.inTurn = false;
    this.turnStartedAt = 0;
    this.audioSec = 0; // số giây âm thanh đã gửi (để ước tính chi phí)
    this.closing = false;
    this.queue = [];
  }

  open(cfg) {
    this.closing = false;
    this.cfg = cfg;
    const url = buildUrl(cfg);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.o.key}` } });
    this.ws = ws;
    ws.on('open', () => {
      for (const b of this.queue.splice(0)) ws.send(b);
      this.o.onState && this.o.onState('open');
    });
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(m);
    });
    ws.on('unexpected-response', (_req, res) => {
      // 401 = sai key, 402 = hết tiền, 400 = tham số sai
      this.o.onState && this.o.onState('error', { status: res.statusCode });
    });
    ws.on('error', (e) => this.o.onState && this.o.onState('error', { message: e.message }));
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      this.o.onState && this.o.onState('closed', { code, reason: String(reason || ''), expected: this.closing });
    });
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(buf) {
    this.audioSec += buf.length / 2 / 16000;
    if (this.isOpen()) this.ws.send(buf);
    else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.queue.push(buf);
      if (this.queue.length > 50) this.queue.shift(); // giữ tối đa ~5 s trong lúc đang kết nối
    }
  }

  close() {
    this.closing = true;
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* bỏ qua */
        }
      }, 300);
    } catch {
      /* bỏ qua */
    }
  }

  handle(m) {
    const emit = this.o.onMessage;
    if (m.type === 'Error' || m.type === 'FatalError' || m.type === 'Warning') {
      this.o.onState && this.o.onState(m.type === 'Warning' ? 'warn' : 'error', { message: m.description || m.message || JSON.stringify(m).slice(0, 200) });
      return;
    }
    const ev = m.event;
    if (!ev) return; // Connected, metadata...
    const text = (m.transcript || '').trim();
    if (!this.inTurn && text && (ev === 'StartOfTurn' || ev === 'Update' || ev === 'EagerEndOfTurn')) {
      this.inTurn = true;
      this.turnStartedAt = Date.now();
      emit({ type: 'speech' });
    }
    if (ev === 'StartOfTurn' || ev === 'Update' || ev === 'TurnResumed') {
      if (text && text !== this.turnText) {
        this.turnText = text;
        emit({ type: 'interim', id: this.id, text });
      }
      if (ev === 'TurnResumed') emit({ type: 'resume', id: this.id });
      return;
    }
    if (ev === 'EagerEndOfTurn') {
      if (text) {
        this.turnText = text;
        emit({ type: 'pause', id: this.id, text, eot_conf: m.end_of_turn_confidence });
      }
      return;
    }
    if (ev === 'EndOfTurn') {
      const id = this.id;
      this.id += 1;
      const words = Array.isArray(m.words) ? m.words : [];
      const dur = words.length ? Math.max(0, words[words.length - 1].end - words[0].start) : 0;
      const meta = {
        dur: Number(dur.toFixed(2)),
        speech_s: Number(dur.toFixed(2)),
        proc_ms: 0,
        reason: 'flux_' + (m.trigger || 'model'),
        eot_conf: m.end_of_turn_confidence,
        turn_ms: this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
        engine: 'deepgram',
      };
      this.inTurn = false;
      this.turnText = '';
      if (text) emit({ type: 'final', id, text, end_of_turn: true, ...meta });
      else emit({ type: 'dropped', id, speech_s: 0 });
    }
  }
}

module.exports = { DeepgramFlux, buildUrl, parseKeyterms };
