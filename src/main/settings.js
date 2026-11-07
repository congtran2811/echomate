const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  provider: 'deepseek',
  suggestProvider: 'same', // 'same' | 'ollama' | 'deepseek': AI riêng cho phần gợi ý trả lời
  deepseekModel: 'deepseek-flash',
  deepseekKeyEnc: '',
  deepgramKeyEnc: '', // key Deepgram (mã hoá), dùng khi sttEngine = 'deepgram'
  deepgramEagerEot: 0.5, // Flux: ngưỡng báo "có vẻ hết lượt" sớm để dịch đoán trước (0,3–0,9)
  micEngine: 'whisper', // micro chạy engine nào: 'whisper' (đo trên giọng bạn: lỗi ~14% so với Nemotron ~28%) | 'same'
  micEnabled: false, // nghe thêm micro của bạn: lời bạn nói được ghi là "Me" để gợi ý sau bám theo
  ollamaModel: 'gemma3:4b',
  style: 'concise',
  replyLength: 'medium',
  replyLevel: 'simple', // 'simple' (A2-B1, câu ngắn dễ đọc to) | 'natural'
  mode: 'chat', // 'chat' = trò chuyện thật | 'tutor' = luyện nói với gia sư (bật luật dịch riêng cho gia sư)
  context: '', // bối cảnh của chế độ gia sư
  contextChat: 'Trò chuyện đời thường với người nước ngoài (nhiều giọng, có thể có tiếng ồn)', // bối cảnh của chế độ trò chuyện
  persona: '', // vai trò và thông tin thật về người dùng: gợi ý chỉ được dùng những dữ kiện này
  glossary: '', // tên riêng/thuật ngữ, cách nhau dấu phẩy: gợi ý cho Whisper và AI
  logAudio: false, // khi ghi log: lưu thêm file WAV từng đoạn (để chạy lại, chẩn đoán)
  logDir: '', // thư mục log; để trống = <thư mục app>\logs
  whisperDir: 'F:\\whisper-stt',
  whisperModel: 'large-v3-turbo',
  whisperDevice: 'cuda',
  sttEngine: 'whisper', // 'whisper' (GPU) | 'nemotron' (streaming CPU) | 'deepgram' (đám mây Flux, tự phát hiện hết lượt, tốn phí)
  nemotronDir: 'F:/whisper-stt/nemotron/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25',
  interim: true,
  silenceMs: 500,
  turnEndMs: 1000, // im lặng bao lâu thì coi là hết lượt nói (đo thực tế: 1500 -> chờ thừa ~0,5 s)
  diarize: false, // nhiều người nói: tách giọng và gán nhãn A, B, C… cho mỗi đoạn (tuỳ chọn, chạy CPU)
  speakerThreshold: 0.42, // độ giống tối thiểu để coi là cùng một người (đã đo: cùng người >= 0,5; khác người <= 0,35)
  localDraft: true, // dịch chính bằng DeepSeek thì hiện trước bản nháp từ model local (nhanh hơn ~0,8 s)
  vadThreshold: 0.008,
  opacity: 0.95,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
  } catch {
    /* lần chạy đầu */
  }
  // v2: đặt lại thời gian chốt câu về mặc định mới (500 ms) cho cài đặt đã lưu từ bản cũ.
  if (!data.v || data.v < 2) data.silenceMs = DEFAULTS.silenceMs;
  // v3: "deepseek-chat" là tên model cũ; tài liệu DeepSeek hiện ghi "deepseek-flash".
  if (!data.v || data.v < 3) {
    if (!data.deepseekModel || data.deepseekModel === 'deepseek-chat') data.deepseekModel = DEFAULTS.deepseekModel;
  }
  // v4: mặc định "hết lượt" giảm từ 1500 xuống 1000 ms; cài đặt cũ còn đúng 1500 (chưa tự chỉnh) thì cập nhật.
  if (!data.v || data.v < 4) {
    if (data.turnEndMs === 1500 || data.turnEndMs === undefined) data.turnEndMs = DEFAULTS.turnEndMs;
  }
  // v5: thêm chế độ trò chuyện/gia sư; cài đặt cũ có bối cảnh luyện với gia sư thì giữ chế độ gia sư.
  if (!data.v || data.v < 5) {
    data.mode = /tutor|gia sư|luyện|practice|lesson|teacher|giáo viên|học tiếng/i.test(data.context || '') ? 'tutor' : 'chat';
  }
  data.v = 5;
  const s = { ...DEFAULTS, ...data };
  s.deepgramKey = '';
  if (s.deepgramKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      s.deepgramKey = safeStorage.decryptString(Buffer.from(s.deepgramKeyEnc, 'base64'));
    } catch {
      s.deepgramKey = '';
    }
  }
  s.deepseekKey = '';
  if (s.deepseekKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      s.deepseekKey = safeStorage.decryptString(Buffer.from(s.deepseekKeyEnc, 'base64'));
    } catch {
      s.deepseekKey = '';
    }
  }
  return s;
}

// patch.deepseekKey: chuỗi mới => lưu mã hoá; undefined => giữ nguyên
function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  if (typeof patch.deepseekKey === 'string' && patch.deepseekKey !== '') {
    next.deepseekKeyEnc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(patch.deepseekKey).toString('base64')
      : '';
  }
  if (typeof patch.deepgramKey === 'string' && patch.deepgramKey !== '') {
    next.deepgramKeyEnc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(patch.deepgramKey).toString('base64')
      : '';
  }
  const toDisk = { ...next, v: 5 };
  delete toDisk.deepseekKey;
  delete toDisk.deepgramKey;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(toDisk, null, 2));
  return load();
}

// Bản gửi cho renderer: không bao giờ chứa key
function publicView(s) {
  const { deepseekKey, deepseekKeyEnc, deepgramKey, deepgramKeyEnc, ...rest } = s;
  return { ...rest, hasKey: !!deepseekKey, hasDeepgramKey: !!deepgramKey };
}

module.exports = { load, save, publicView };
