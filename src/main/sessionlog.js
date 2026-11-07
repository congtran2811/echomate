// Ghi log phiên dùng thật ra file JSONL để kiểm tra/chẩn đoán sau (bật bằng nút 📝 trên giao diện).
// Mỗi phiên là một thư mục: events.jsonl (+ audio/ nếu bật lưu WAV). Log chứa NỘI DUNG câu nói và gợi ý.
const fs = require('fs');
const path = require('path');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class SessionLog {
  constructor() {
    this.stream = null;
    this.dir = null;
    this.file = null;
    this.t0 = 0;
    this.counts = {};
  }

  isOn() {
    return !!this.stream;
  }

  state() {
    return { on: this.isOn(), dir: this.dir, file: this.file, audioDir: this.audioDir() };
  }

  audioDir() {
    return this.dir ? path.join(this.dir, 'audio') : '';
  }

  // baseDir: thư mục chứa các phiên; trả về false nếu không ghi được.
  start(baseDir, meta) {
    if (this.stream) return true;
    try {
      this.dir = path.join(baseDir, `session-${stamp()}`);
      fs.mkdirSync(this.dir, { recursive: true });
      this.file = path.join(this.dir, 'events.jsonl');
      // Ghi đồng bộ từng dòng: khối lượng nhỏ (vài sự kiện/giây) và không mất dòng cuối khi app tắt đột ngột.
      fs.writeFileSync(this.file, '');
      this.stream = true;
      this.t0 = Date.now();
      this.counts = {};
      this.event('session_start', meta);
      return true;
    } catch (e) {
      console.error('[log] không tạo được thư mục log:', e.message);
      this.stream = null;
      this.dir = null;
      this.file = null;
      return false;
    }
  }

  event(type, data = {}) {
    if (!this.stream) return;
    this.counts[type] = (this.counts[type] || 0) + 1;
    const rec = { t: Date.now() - this.t0, ts: new Date().toISOString(), type, ...data };
    try {
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.error('[log] lỗi ghi file:', e.message);
    }
  }

  stop() {
    if (!this.stream) return;
    this.event('session_end', { counts: this.counts, seconds: Math.round((Date.now() - this.t0) / 1000) });
    this.stream = null;
  }
}

module.exports = { SessionLog };
