const { app, BrowserWindow, ipcMain, session, desktopCapturer, globalShortcut, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const settingsStore = require('./settings');
const llm = require('./llm');
const gpu = require('./gpu');
const { isNonEnglish, isPhantom, fixStt, fixGlossary, endsWithQuestion } = require('./lang');
const fixText = (t) => fixGlossary(fixStt(t), settings.glossary);
const { SessionLog } = require('./sessionlog');
const { DeepgramFlux, parseKeyterms } = require('./deepgram');

let win = null;
let proc = null;
let ws = null;
let micWs = null; // kết nối thứ hai tới sidecar cho micro của bạn
let dg = null; // kết nối Deepgram Flux khi sttEngine = 'deepgram'
let dgRetries = 0;
// Bộ chọn công cụ nhận dạng: Deepgram chạy trên mạng; sidecar vẫn cần cho micro (dùng Nemotron trên CPU, miễn phí).
const useDeepgram = () => settings.sttEngine === 'deepgram';
const sidecarEngine = () => (useDeepgram() ? 'nemotron' : settings.sttEngine);
const needSidecar = () => !useDeepgram() || !!settings.micEnabled;
// Micro chạy Whisper (GPU) khi engine chính là Nemotron: sidecar nạp thêm Whisper và kết nối micro tự chọn engine.
const micWhisper = () => !!settings.micEnabled && settings.micEngine === 'whisper' && sidecarEngine() === 'nemotron';
let sttPort = 0;
let sidecarGen = 0;
let settings = null;
let history = [];
let clickThrough = false;
let suggestAbort = null;
let sidecarRestarts = 0;
const slog = new SessionLog();

process.on('uncaughtException', (e) => console.error('[main] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[main] unhandled rejection:', e));

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const status = (state, message) => send('stt-status', { state, message });

// ---- Banner cảnh báo trên giao diện (theo khoá, tự xoá khi hết vấn đề) ----
const banners = new Map();
function setBanner(key, level, text) {
  banners.set(key, { key, level, text });
  send('banner', [...banners.values()]);
}
function clearBanner(key) {
  if (banners.delete(key)) send('banner', [...banners.values()]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 740,
    minWidth: 360,
    minHeight: 420,
    frame: false,
    backgroundColor: '#14161a',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setOpacity(settings.opacity);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    send('banner', [...banners.values()]);
    send('log-state', slog.state());
  });
}

// Thu âm thanh phát ra loa (loopback) của toàn hệ thống.
function setupLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    },
    { useSystemPicker: false }
  );
}

// ---- Tiến trình Whisper ----
const pidFile = () => path.join(app.getPath('userData'), 'sidecar.pid');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Python trong venv chạy qua một tiến trình "launcher" + tiến trình con; proc.kill() chỉ giết launcher
// và để lại tiến trình con chiếm VRAM, nên phải giết cả cây.
function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}
function killTreeSync(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* tiến trình đã tắt */
  }
}

// Lần chạy trước bị tắt đột ngột (sập, kill) có thể để lại Whisper chiếm VRAM: tìm theo PID đã lưu và dọn.
async function cleanupOrphan() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile(), 'utf8'));
  } catch {
    return;
  }
  if (!pid) return;
  const cmd = await new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { timeout: 8000, windowsHide: true },
      (err, out) => resolve(err ? '' : String(out))
    );
  });
  if (/server\.py/.test(cmd)) {
    await killTree(pid);
    console.log('[stt] da don tien trinh Whisper cu, pid', pid);
  }
  try {
    fs.unlinkSync(pidFile());
  } catch {
    /* không có file */
  }
}

function stopSidecar() {
  sidecarGen += 1;
  if (ws) {
    try { ws.close(); } catch { /* bỏ qua */ }
    ws = null;
  }
  if (micWs) {
    try { micWs.close(); } catch { /* bỏ qua */ }
    micWs = null;
  }
  if (proc) {
    killTreeSync(proc.pid);
    proc = null;
  }
  try {
    fs.unlinkSync(pidFile());
  } catch {
    /* không có file */
  }
}

async function startSidecar() {
  stopSidecar();
  const gen = sidecarGen;
  const dir = settings.whisperDir;
  const python = path.join(dir, 'venv', 'Scripts', 'python.exe');
  const script = path.join(dir, 'server.py');
  if (useDeepgram() && !settings.deepgramKey) {
    status('error', 'Chưa nhập API key Deepgram (Cài đặt)');
    return;
  }
  if (!needSidecar()) {
    status('ready', 'Deepgram sẵn sàng (nhận dạng trên mạng)');
    slog.event('stt_ready', { engine: 'deepgram' });
    return;
  }
  const nemo = sidecarEngine() === 'nemotron';
  if (nemo && !fs.existsSync(path.join(settings.nemotronDir, 'encoder.int8.onnx'))) {
    status('error', `Chưa có model Nemotron tại ${settings.nemotronDir}. Xem README (mục Nemotron).`);
    slog.event('warn', { what: 'nemotron_missing', dir: settings.nemotronDir });
    return;
  }
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    status('error', `Chưa cài Whisper tại ${dir}. Chạy: npm run setup:whisper`);
    slog.event('warn', { what: 'whisper_missing', dir });
    return;
  }
  status('loading', nemo ? 'Đang nạp model Nemotron…' : 'Đang nạp model Whisper…');
  try {
    sttPort = await getFreePort();
  } catch (e) {
    status('error', 'Không tìm được cổng trống cho Whisper');
    return;
  }
  if (gen !== sidecarGen) return; // đã có lần khởi động khác thay thế
  const me = spawn(
    python,
    [script, '--port', String(sttPort), '--model', settings.whisperModel, '--device', settings.whisperDevice, ...(nemo ? ['--engine', 'nemotron', '--nemo-dir', settings.nemotronDir] : []), ...(micWhisper() ? ['--mic-whisper'] : [])],
    {
      env: {
        ...process.env,
        HF_HOME: path.join(dir, 'models'),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    }
  );
  proc = me;
  try {
    fs.writeFileSync(pidFile(), String(me.pid));
  } catch {
    /* không quan trọng */
  }
  const onLine = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.log('[stt]', line);
      if (line.startsWith('READY')) connectWs(sttPort);
      if (line.startsWith('ERROR')) status('error', line);
    }
  };
  me.stdout.on('data', onLine);
  me.stderr.on('data', onLine);
  me.on('exit', (code) => {
    if (proc !== me) return; // bị thay thế hoặc tắt chủ động
    proc = null;
    console.error('[stt] Whisper dừng, mã', code);
    slog.event('warn', { what: 'sidecar_exit', code });
    if (sidecarRestarts < 3) {
      sidecarRestarts += 1;
      status('loading', 'Whisper dừng đột ngột, đang khởi động lại…');
      setTimeout(startSidecar, 1000);
    } else {
      status('error', `Whisper dừng (mã ${code})`);
    }
  });
}

function connectWs(port, retry = 0) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  ws = sock;
  sock.on('open', () => {
    retry = 0;
    pushSttConfig();
    status('ready', useDeepgram() ? 'Deepgram sẵn sàng (micro: Nemotron trên máy)' : 'Whisper sẵn sàng');
    slog.event('stt_ready', { port, engine: settings.sttEngine });
    if (settings.micEnabled && !micWs) connectMicWs(port);
  });
  sock.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (useDeepgram()) return; // sidecar chỉ phục vụ micro; âm thanh hệ thống đi Deepgram
      handleStt(m);
    } catch (e) {
      console.error('[stt] lỗi xử lý tin nhắn:', e);
    }
  });
  sock.on('error', (e) => console.error('[ws] lỗi:', e.message));
  sock.on('close', (code, reason) => {
    console.warn('[ws] đóng kết nối', code, reason.toString());
    slog.event('warn', { what: 'ws_closed', code });
    if (ws !== sock || !proc) return; // đã bị thay thế hoặc đang tắt chủ động
    status('loading', 'Mất kết nối Whisper, đang nối lại…');
    setTimeout(() => {
      if (ws === sock && proc) connectWs(port, retry + 1);
    }, Math.min(500 * (retry + 1), 3000));
  });
}

function connectMicWs(port, retry = 0) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  micWs = sock;
  sock.on('open', () => {
    pushSttConfig();
    slog.event('mic_ready', { port });
  });
  sock.on('message', (data) => {
    try {
      handleMic(JSON.parse(data.toString()));
    } catch (e) {
      console.error('[mic] lỗi xử lý tin nhắn:', e);
    }
  });
  sock.on('error', (e) => console.error('[mic ws] lỗi:', e.message));
  sock.on('close', () => {
    if (micWs !== sock || !proc || !settings.micEnabled) return;
    setTimeout(() => {
      if (micWs === sock && proc) connectMicWs(port, retry + 1);
    }, Math.min(500 * (retry + 1), 3000));
  });
}

// Tên riêng/thuật ngữ ưu tiên nhận dạng (hotwords của Whisper). Không đưa ô "bối cảnh" vào đây: dùng làm
// initial_prompt thì Whisper bỏ mất chữ đầu câu khi chủ đề lệch.
function whisperHotwords() {
  return (settings.glossary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function pushSttConfig() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      interim: settings.interim,
      silence_ms: settings.silenceMs,
      threshold: settings.vadThreshold,
      hotwords: whisperHotwords(),
      diarize: !!settings.diarize,
      speaker_threshold: settings.speakerThreshold || 0.42,
      save_audio_dir: slog.isOn() && settings.logAudio ? slog.audioDir() : '',
    }));
  }
  if (micWs && micWs.readyState === WebSocket.OPEN) {
    micWs.send(JSON.stringify({
      engine: micWhisper() ? 'whisper' : sidecarEngine(),
      interim: true,
      // Bạn hay ngập ngừng khi nói (log thật: "We depl" / "One" / "So I say we clear" bị tách rời): chờ im lâu hơn mới chốt câu.
      silence_ms: Math.max(settings.silenceMs || 500, 900),
      threshold: settings.vadThreshold,
      hotwords: whisperHotwords(),
      diarize: false,
      // Lưu WAV micro khi ghi log kèm âm thanh: để so engine nào nghe giọng bạn đúng hơn.
      save_audio_dir: slog.isOn() && settings.logAudio ? path.join(slog.audioDir(), 'mic') : '',
    }));
  }
}

// ---- Deepgram Flux ----
function openDeepgram() {
  closeDeepgram();
  if (!settings.deepgramKey) {
    setBanner('deepgram', 'error', 'Chưa nhập API key Deepgram (Cài đặt).');
    return;
  }
  const me = new DeepgramFlux({
    key: settings.deepgramKey,
    onMessage: (m) => {
      if (dg !== me) return;
      try {
        handleStt(m);
      } catch (e) {
        console.error('[deepgram] lỗi xử lý tin nhắn:', e);
      }
    },
    onState: (st, info = {}) => {
      if (dg !== me) return;
      if (st === 'open') {
        dgRetries = 0;
        clearBanner('deepgram');
        slog.event('deepgram_open', {});
      } else if (st === 'error') {
        const why = info.status === 401 ? 'sai API key' : info.status === 402 ? 'tài khoản hết tiền' : info.message || `mã ${info.status}`;
        setBanner('deepgram', 'error', `Deepgram lỗi: ${why}`);
        slog.event('deepgram_error', { status: info.status, message: info.message });
      } else if (st === 'warn') {
        slog.event('deepgram_warn', { message: info.message });
      } else if (st === 'closed') {
        slog.event('deepgram_closed', { code: info.code, expected: !!info.expected, audio_s: Math.round(me.audioSec) });
        if (!info.expected && listening && useDeepgram() && dgRetries < 5) {
          dgRetries += 1;
          setTimeout(() => {
            if (dg === me && listening) openDeepgram();
          }, 1000 * dgRetries);
        }
      }
    },
  });
  dg = me;
  me.open({ eagerEot: settings.deepgramEagerEot || 0.5, keyterms: parseKeyterms(settings.glossary) });
}

function closeDeepgram() {
  if (!dg) return;
  const old = dg;
  dg = null;
  slog.event('deepgram_usage', { audio_s: Math.round(old.audioSec) });
  old.close();
}

// ---- Nghẽn GPU: tự chuyển sang DeepSeek ----
// Model local chạy chung GPU với Whisper và app khác; khi VRAM chạm mép, một bản dịch từng mất tới 2 phút.
const SLOW_MS = 3000; // bản dịch local bình thường 0,2–0,5 s
const FALLBACK_MS = 5 * 60 * 1000;
let fallbackUntil = 0;
const recentSlow = [];
let llmErrStreak = 0;

const fallbackActive = () => Date.now() < fallbackUntil;

// Cấu hình AI đang thực sự được dùng (có thể bị ghi đè tạm sang DeepSeek khi GPU nghẽn).
// Cài đặt hiệu lực cho các lần gọi LLM: bối cảnh lấy theo chế độ đang chọn (gia sư / trò chuyện).
function eff() {
  const base = { ...settings, context: settings.mode === 'tutor' ? settings.context : settings.contextChat };
  if (fallbackActive() && settings.deepseekKey) return { ...base, provider: 'deepseek', suggestProvider: 'deepseek' };
  return base;
}

function noteTranslate(provider, ms, failed) {
  if (provider !== 'ollama') return;
  recentSlow.push(failed || ms > SLOW_MS ? 1 : 0);
  if (recentSlow.length > 4) recentSlow.shift();
  const slowCount = recentSlow.slice(-3).filter(Boolean).length;
  if (slowCount < 2 || fallbackActive()) return;
  recentSlow.length = 0;
  if (settings.deepseekKey) {
    fallbackUntil = Date.now() + FALLBACK_MS;
    setBanner('fallback', 'warn', 'GPU nghẽn: tạm dùng DeepSeek cho phần dịch và gợi ý trong 5 phút. Hãy tắt bớt app dùng GPU.');
    slog.event('fallback_on', { until: new Date(fallbackUntil).toISOString() });
    setTimeout(() => {
      clearBanner('fallback');
      slog.event('fallback_off', {});
    }, FALLBACK_MS);
  } else {
    setBanner('fallback', 'warn', 'GPU nghẽn: bản dịch đang rất chậm. Tắt bớt app dùng GPU, hoặc nhập API key DeepSeek để app tự chuyển.');
    slog.event('fallback_needed_no_key', {});
    setTimeout(() => clearBanner('fallback'), 60000);
  }
}

function noteLlmResult(ok, message) {
  if (ok) {
    llmErrStreak = 0;
    clearBanner('llm');
    return;
  }
  llmErrStreak += 1;
  if (llmErrStreak >= 3) setBanner('llm', 'error', `Lỗi AI: ${message}`);
}

const niceError = (e) =>
  /fetch failed|ECONNREFUSED/i.test(e.message) ? 'Không kết nối được tới AI (Ollama chưa chạy hoặc mất mạng)' : e.message;

// Theo dõi VRAM: cảnh báo khi gần đầy (nguyên nhân chính gây model chậm hàng chục lần).
let vramHigh = false;
let lastGpu = null;
async function pollGpu() {
  const g = await gpu.sample();
  if (!g) return;
  lastGpu = g;
  slog.event('gpu', { used_mb: g.usedMb, total_mb: g.totalMb, util: g.util });
  const ratio = g.usedMb / g.totalMb;
  if (!vramHigh && ratio >= 0.96) {
    vramHigh = true;
    setBanner(
      'vram',
      'warn',
      `VRAM gần đầy (${(g.usedMb / 1024).toFixed(1)}/${(g.totalMb / 1024).toFixed(1)} GB): model có thể chạy rất chậm. Hãy tắt bớt app dùng GPU.`
    );
  } else if (vramHigh && ratio < 0.92) {
    vramHigh = false;
    clearBanner('vram');
  }
}

// ---- Theo dõi token/chi phí gợi ý ----
// Giá DeepSeek tham khảo (USD / 1 triệu token, giờ cao điểm = cận trên, coi như không có cache hit).
// Kiểm tra lại trên api-docs.deepseek.com/quick_start/pricing; chi phí thật xem ở trang sử dụng của DeepSeek.
const DS_PEAK = { inMiss: 0.3, out: 1.2 };
const sessionCost = { calls: 0, tokIn: 0, tokOut: 0, usd: 0, ms: 0 };

function logSuggestCost(id, out, firstMs, totalMs) {
  const exact = out.usage && out.usage.prompt_tokens != null;
  const tIn = exact ? out.usage.prompt_tokens : out.est.prompt;
  const tOut = exact ? out.usage.completion_tokens : out.est.completion;
  const usd = out.est.provider === 'deepseek' ? (tIn * DS_PEAK.inMiss + tOut * DS_PEAK.out) / 1e6 : 0;
  sessionCost.calls += 1;
  sessionCost.tokIn += tIn;
  sessionCost.tokOut += tOut;
  sessionCost.usd += usd;
  sessionCost.ms += totalMs;
  const approx = exact ? '' : '~';
  console.log(
    `[llm] suggest id=${id} ${out.est.provider} replies=${out.count} first=${firstMs}ms total=${totalMs}ms ` +
      `tok ${approx}${tIn} in + ${approx}${tOut} out` +
      (out.est.provider === 'deepseek' ? ` ~ $${usd.toFixed(5)}` : '')
  );
  // Log ASCII: terminal Windows hiển thị sai dấu tiếng Việt.
  console.log(
    `[cost] session: ${sessionCost.calls} suggestions, avg ${Math.round(sessionCost.ms / sessionCost.calls)}ms, ` +
      `${sessionCost.tokIn} in + ${sessionCost.tokOut} out tokens, ~ $${sessionCost.usd.toFixed(5)} (upper bound, peak price, no cache)`
  );
  return { tIn, tOut, usd, exact };
}

// ---- Lượt nói ----
// Mỗi "đoạn" (câu được chốt sau ~0,5 s im lặng) được dịch ngay. Các đoạn liên tiếp gom thành một "lượt nói";
// gợi ý chỉ chạy khi người kia ngừng đủ lâu (hết lượt), dựa trên cả lượt. Lượt quá dài thì gợi ý giữa chừng.
const MID_TURN_MS = 25000; // lượt dài: cập nhật gợi ý mỗi ~25 s
const TURN_TEXT_MAX = 700; // chỉ gửi ~700 ký tự cuối của lượt cho LLM
let turn = null; // { segs: [{id, text}], startedAt, lastSuggestAt, suggested }
let turnTimer = null;
let priorTurns = []; // các lượt trước, làm ngữ cảnh cho gợi ý
let lastFinalAt = 0;
// ---- Nhiều người nói (tuỳ chọn): sidecar gán spk 0,1,2… cho mỗi đoạn; bạn bấm vào nhãn để đánh dấu "đây là tôi" ----
let meSpk = null; // người nói được đánh dấu là bạn (null = chưa đánh dấu)
const spkLetter = (n) => String.fromCharCode(65 + (n % 26));
const spkLabel = (spk) => (spk === null ? null : spk === meSpk ? 'Me' : `Speaker ${spkLetter(spk)}`);
let turnSeq = 0; // số thứ tự lượt nói, để giao diện gom gợi ý theo lượt
let lastTurnNo = 0;

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
}

// Hẹn giờ coi là hết lượt: đã im sẵn silenceMs khi đoạn được chốt, chờ thêm cho đủ turnEndMs.
function armTurnTimer() {
  clearTurnTimer();
  const extra = Math.max(0, (settings.turnEndMs || 1000) - (settings.silenceMs || 500));
  turnTimer = setTimeout(() => {
    turnTimer = null;
    runSuggest(true);
  }, extra);
}

function closeTurn() {
  if (turn) {
    const body = turn.segs.map((s) => s.text).join(' ').slice(-400);
    const who = turn.spk === null || turn.spk === undefined ? null : spkLabel(turn.spk);
    priorTurns.push(who ? `${who}: ${body}` : body);
    priorTurns = priorTurns.slice(-6);
  }
  turn = null;
}

// Ollama chỉ chạy một yêu cầu một lúc và GPU 8 GB đang chia cho Whisper, nên:
// - bản dịch được ưu tiên: gợi ý chờ cho tới khi không còn bản dịch nào đang chạy;
// - gợi ý giữa chừng bị bỏ qua khi GPU còn bận (sẽ thử lại ở đoạn sau).
let pendingTranslations = 0;
let suggestBusy = false;
// Phần gợi ý có chạy trên Ollama (cùng GPU với phần dịch) không? Nếu chạy DeepSeek thì không cần xếp hàng.
const localLlm = () => {
  const s = eff();
  return (s.suggestProvider && s.suggestProvider !== 'same' ? s.suggestProvider : s.provider) === 'ollama';
};

async function waitForTranslations(signal) {
  const start = Date.now();
  while (pendingTranslations > 0 && !signal.aborted && Date.now() - start < 4000) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

function runSuggest(endOfTurn) {
  if (!turn) return;
  // Xét "đây là tôi" ngay lúc chốt lượt (không phải lúc lượt bắt đầu): bạn thường bấm nhãn khi người đó đang nói dở.
  if (turn.spk !== null && turn.spk !== undefined && turn.spk === meSpk) {
    // Lượt của chính bạn: không cần gợi ý, chỉ đưa vào ngữ cảnh cho các gợi ý sau.
    if (turn.segs.length !== turn.suggested) {
      slog.event('turn_skipped_me', { turn: turn.no, spk: turn.spk, text: turn.segs.map((x) => x.text).join(' ').slice(0, 200) });
    }
    if (endOfTurn) closeTurn();
    return;
  }
  if (turn.segs.length === turn.suggested) {
    if (endOfTurn) closeTurn(); // gợi ý giữa chừng đã bao trọn lượt
    return;
  }
  if (!endOfTurn && localLlm() && (pendingTranslations > 0 || suggestBusy)) return;
  const segs = turn.segs;
  const last = segs[segs.length - 1];
  const full = segs.map((s) => s.text).join(' ');
  const text = full.length > TURN_TEXT_MAX ? '…' + full.slice(-TURN_TEXT_MAX) : full;
  const prior = priorTurns.slice();
  console.log(`[turn] suggest ${endOfTurn ? 'end' : 'mid'} segs=${segs.length} chars=${text.length}`);
  slog.event('turn_suggest', {
    mode: endOfTurn ? 'end' : 'mid',
    segs: segs.length,
    chars: text.length,
    text,
    spk: turn.spk === undefined ? null : turn.spk,
    context: prior.slice(-3), // ngữ cảnh gửi kèm (có dòng "Me: …" khi đã đánh dấu), để kiểm tra sau
    since_last_final_ms: Date.now() - lastFinalAt,
  });
  const spkMeta = turn.spk === null || turn.spk === undefined ? null : { spk: turn.spk, label: spkLabel(turn.spk) };
  turn.suggested = segs.length;
  turn.lastSuggestAt = Date.now();
  lastTurnNo = turn.no;
  if (endOfTurn) closeTurn();
  startSuggest(last.id, prior, text, last.text, turn ? turn.no : lastTurnNo, spkMeta);
}

async function startSuggest(id, prior, text, echoSource, turnNo, spkMeta = null) {
  if (suggestAbort) suggestAbort.abort(); // chỉ huỷ khi có gợi ý MỚI bắt đầu; không huỷ chỉ vì người kia nói tiếp
  const expected = llm.wantReply(text);
  const q = text.length > 110 ? '…' + text.slice(-110) : text; // câu của họ, làm tiêu đề bộ gợi ý
  send('replies-start', { id, turnNo, expected, q, spk: spkMeta ? spkMeta.spk : null });
  if (!expected) {
    send('replies-end', { id, turnNo, count: 0 });
    slog.event('suggest_skipped', { id, turn: turnNo, text });
    return;
  }
  const ctrl = new AbortController();
  suggestAbort = ctrl;
  const t0 = Date.now();
  let firstMs = 0;
  const got = [];
  // Nhiều người nói: báo cho LLM biết ai vừa nói và rằng các dòng "Me:" là lời bạn đã nói.
  const es = spkMeta ? { ...eff(), diarize: true, whoLabel: spkMeta.label } : eff();
  suggestBusy = true;
  try {
    if (localLlm()) await waitForTranslations(ctrl.signal);
    if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = await llm.suggest(
      es,
      prior,
      text,
      (r) => {
        if (!firstMs) firstMs = Date.now() - t0;
        got.push(r);
        send('reply', { id, turnNo, ...r });
      },
      ctrl.signal,
      echoSource
    );
    const cost = logSuggestCost(id, out, firstMs, Date.now() - t0);
    if (out.usageP) {
      out.usageP.then((u) => {
        if (u) {
          slog.event('suggest_usage', {
            id,
            tok_in: u.prompt_tokens,
            tok_out: u.completion_tokens,
            cache_hit: u.prompt_cache_hit_tokens,
            cache_miss: u.prompt_cache_miss_tokens,
          });
        }
      });
    }
    noteLlmResult(true);
    slog.event('suggest', {
      id,
      turn: turnNo,
      provider: out.est.provider,
      fallback: fallbackActive(),
      first_ms: firstMs,
      total_ms: Date.now() - t0,
      count: out.count,
      replies: got,
      tok_in: cost.tIn,
      tok_out: cost.tOut,
      tok_exact: cost.exact,
      usd_upper: Number(cost.usd.toFixed(6)),
    });
    send('replies-end', { id, turnNo, count: out.count, usage: out.usage });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log(`[llm] suggest id=${id} bi huy sau ${Date.now() - t0}ms (${got.length} goi y)`);
      slog.event('suggest_abort', { id, ms: Date.now() - t0, had_replies: got.length });
      return;
    }
    console.error('[llm] suggest', e.message);
    noteLlmResult(false, niceError(e));
    slog.event('suggest_error', { id, ms: Date.now() - t0, error: e.message, timeout: !!e.timeout, had_replies: got.length });
    send('replies-end', { id, turnNo, count: got.length, error: niceError(e) });
  } finally {
    if (suggestAbort === ctrl) suggestBusy = false;
  }
}

// Dịch bằng DeepSeek; nếu lỗi (mất mạng, hết tiền, quá tải) thì dùng bản nháp local (hoặc gọi local) để không mất bản dịch.
async function translateWithFallback(es, prior, text, draftP) {
  try {
    return { ...(await llm.translate(es, prior, text)), provider: es.provider };
  } catch (e) {
    if (es.provider !== 'deepseek' || !settings.ollamaModel) throw e;
    slog.event('translate_fallback_local', { error: e.message });
    const out = await (draftP || llm.translate({ ...es, provider: 'ollama' }, prior, text));
    return { ...out, provider: 'ollama', fellBack: true };
  }
}

// Dịch nháp tiến trình: khi người kia còn nói mà đã xong một hay vài câu (chữ tạm có dấu . ? ! rồi tới chữ tiếp), dịch nháp
// phần đã xong bằng model local và hiện ngay, để bạn đọc được nửa đầu trong lúc họ nói nửa sau. Khi chốt câu, chỉ dịch nháp phần
// đuôi rồi ghép; bản DeepSeek vẫn dịch cả đoạn một lần và thay thế tất cả.
let prog = null; // { id, prefix, vi, busy, want }
const SENT_PREFIX_RE = /^(.*[.?!])\s+\S/s;
function progressiveDraft(id, text) {
  if (settings.localDraft === false || !settings.ollamaModel || eff().provider !== 'deepseek') return;
  const m = SENT_PREFIX_RE.exec(text);
  if (!m || m[1].split(/\s+/).length < 3) return;
  if (!prog || prog.id !== id) prog = { id, prefix: '', vi: '', busy: false, want: '' };
  if (m[1] === prog.prefix) return;
  prog.want = m[1];
  if (prog.busy) return;
  const run = (p) => {
    const prefix = p.want;
    p.busy = true;
    const t0 = Date.now();
    llm
      .translate({ ...eff(), provider: 'ollama' }, history.slice(), prefix)
      .then((d) => {
        if (prog !== p) return; // đã chốt câu hoặc sang đoạn khác
        p.prefix = prefix;
        p.vi = d.vi;
        slog.event('translate_draft_partial', { id: p.id, ms: Date.now() - t0, prefix, vi: d.vi });
        send('translation', { id: p.id, vi: d.vi, draft: true });
      })
      .catch(() => {})
      .finally(() => {
        p.busy = false;
        if (prog === p && p.want !== p.prefix && p.want !== prefix) run(p);
      });
  };
  run(prog);
}

// ---- Dịch đoán trước ----
// Khi công cụ nhận dạng báo "có vẻ đã hết câu" (Deepgram: EagerEndOfTurn; Nemotron: im lặng ~0,25 s), gửi DeepSeek dịch ngay
// chữ hiện có. Khi câu chốt đúng y chữ đó thì dùng luôn kết quả, bớt thời gian chờ; khác chữ thì bỏ (tốn thêm một lần dịch).
let spec = null; // { id, text, key, p, t0, vi, shown }
const normKey = (t) => (t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function startSpec(id, rawText) {
  const text = fixText(rawText || '');
  if (text.split(/\s+/).length < 2 || isNonEnglish(text)) return;
  const key = normKey(text);
  if (spec && spec.id === id && spec.key === key) return;
  const es = eff();
  if (es.provider !== 'deepseek') return; // dịch local đã nhanh, không cần đoán trước
  const me = { id, text, key, t0: Date.now(), vi: null, shown: false };
  me.p = translateWithFallback(es, history.slice(), text, null);
  me.p
    .then((out) => {
      me.vi = out.vi;
      // Hiện trước dưới dạng bản nháp (chữ nghiêng) trong lúc chờ chốt câu; chốt đúng chữ thì thành bản chính.
      if (spec === me) {
        me.shown = true;
        send('translation', { id, vi: out.vi, draft: true });
      }
    })
    .catch(() => {});
  spec = me;
  slog.event('spec_start', { id, text: text.slice(0, 200) });
}

// ---- Micro của bạn ("Me") ----
// Lời bạn nói được ghi vào ngữ cảnh để gợi ý sau bám theo. Nếu bạn dùng loa ngoài, micro thu lại giọng người kia: bỏ đoạn
// micro trùng phần lớn với câu hệ thống vừa nghe (tiếng vọng).
const recentSys = []; // [{ t, words:Set }]
let lastSysInterim = '';
let lastSysVoiceAt = 0; // lúc gần nhất nghe thấy người kia (bắt đầu nói, chữ tạm, chốt câu)
const wordsOf = (t) => normKey(t).split(' ').filter((w) => w.length >= 3);
function noteSystemText(text) {
  recentSys.push({ t: Date.now(), words: new Set(wordsOf(text)) });
  while (recentSys.length && Date.now() - recentSys[0].t > 20000) recentSys.shift();
}
function echoRatio(text) {
  const w = wordsOf(text);
  if (w.length < 3) return 0;
  const pool = new Set(wordsOf(lastSysInterim));
  for (const r of recentSys) if (Date.now() - r.t < 20000) for (const x of r.words) pool.add(x);
  return w.filter((x) => pool.has(x)).length / w.length;
}

function handleMic(msg) {
  if (!listening || !settings.micEnabled) return;
  const mid = 'm' + msg.id;
  if (msg.type === 'interim') {
    send('utterance', { id: mid, en: fixText(msg.text), final: false, me: true });
    return;
  }
  if (msg.type === 'dropped' || msg.type === 'empty') {
    send('utterance', { id: mid, dropped: true });
    return;
  }
  if (msg.type !== 'final') return;
  const text = fixText(msg.text);
  const echo = echoRatio(text);
  // Tiếng vọng xuất hiện CÙNG LÚC người kia đang nói (log thật: chậm 0,2–0,5 s sau câu của họ, trùng 100% chữ). Câu trả lời
  // thật của bạn thì nói sau đó và có thể trùng vài từ với câu hỏi ("I went to ... this morning" trùng 67%) — không được bỏ.
  const sinceSys = Date.now() - lastSysVoiceAt;
  // Chỉ xét tiếng vọng khi người kia vừa nói trong 2 s trước. Log thật: bạn nhắc lại đúng câu gia sư vừa sửa sau 10 s (trùng 100%)
  // là luyện tập, không phải tiếng vọng.
  const isEcho = sinceSys < 2000 && echo >= 0.5;
  if (isPhantom(text, msg.rms_voiced) || isEcho) {
    slog.event('mic_dropped', { id: msg.id, text, echo: Number(echo.toFixed(2)), since_sys_ms: sinceSys, rms: msg.rms_voiced });
    send('utterance', { id: mid, dropped: true });
    return;
  }
  slog.event('mic_final', { id: msg.id, text, dur: msg.dur, echo: Number(echo.toFixed(2)), since_sys_ms: sinceSys, rms: msg.rms_voiced, wav: msg.wav || '' });
  send('utterance', { id: mid, en: text, final: true, me: true });
  // Bạn đã lên tiếng: lượt của người kia coi như xong (gợi ý cho lượt đó nếu chưa có), rồi ghi lời bạn vào ngữ cảnh.
  if (turn) {
    clearTurnTimer();
    runSuggest(true);
  }
  priorTurns.push(`Me: ${text}`);
  priorTurns = priorTurns.slice(-6);
  history.push(`Me: ${text}`);
  history = history.slice(-12);
}

function handleStt(msg) {
  if (msg.type === 'warn') {
    const miss = /speaker_/.test(msg.what || '');
    if (miss) {
      setBanner('speaker', 'warn', 'Chưa dùng được tách người nói (' + String(msg.what).replace('speaker_', '') + '). Chạy: npm run setup:whisper');
      slog.event('warn', { what: msg.what });
    }
    return;
  }
  if (msg.type === 'speech') {
    lastSysVoiceAt = Date.now();
    clearTurnTimer(); // người kia nói tiếp → chưa hết lượt
    return;
  }
  if (msg.type === 'pause') {
    startSpec(msg.id, msg.text);
    return;
  }
  if (msg.type === 'resume') {
    if (spec && spec.id === msg.id) {
      slog.event('spec_cancel', { id: msg.id });
      spec = null;
    }
    return;
  }
  if (msg.type === 'interim') {
    clearTurnTimer();
    msg.text = fixText(msg.text);
    lastSysInterim = msg.text;
    lastSysVoiceAt = Date.now();
    send('utterance', { id: msg.id, en: msg.text, final: false });
    progressiveDraft(msg.id, msg.text);
    return;
  }
  // Đoạn bị bỏ (quá ngắn, không ra chữ, nhiễu): xoá dòng chữ tạm đã hiện trên màn hình và hẹn lại giờ chốt lượt, vì tín hiệu
  // 'speech' trước đó đã huỷ hẹn giờ; không hẹn lại thì gợi ý của lượt đang chờ bị mất.
  const discard = (id) => {
    if (prog && prog.id === id) prog = null;
    send('utterance', { id, dropped: true });
    if (turn) armTurnTimer();
  };
  if (msg.type === 'dropped') {
    slog.event('stt_dropped', { id: msg.id, speech_s: msg.speech_s });
    discard(msg.id);
    return;
  }
  if (msg.type === 'empty') {
    const { type, ...meta } = msg;
    slog.event('stt_empty', meta);
    discard(msg.id);
    return;
  }
  if (msg.type !== 'final') return;
  const { type, ...meta } = msg;
  const rawText = msg.text;
  msg.text = fixText(msg.text);
  if (msg.text !== rawText) meta.text_raw = rawText;
  meta.text = msg.text;
  slog.event('stt_final', meta);
  // "Thank you."/"you" từ tiếng ồn rất nhỏ: Whisper nghe ra chữ không có thật. Bỏ, không dịch, không gợi ý.
  if (isPhantom(msg.text, msg.rms_voiced)) {
    slog.event('stt_noise_dropped', { id: msg.id, text: msg.text, rms: msg.rms_voiced });
    discard(msg.id);
    return;
  }
  // Không phải tiếng Anh (video tiếng Việt, nhạc có lời...): không dịch, không gợi ý, không đưa vào ngữ cảnh.
  if (isNonEnglish(msg.text)) {
    slog.event('stt_non_english', { id: msg.id, text: msg.text });
    send('utterance', { id: msg.id, en: msg.text, final: true, nonEnglish: true });
    if (turn) armTurnTimer(); // tiếng 'speech' đã huỷ hẹn giờ của lượt tiếng Anh đang chờ: hẹn lại để không mất gợi ý
    return;
  }
  lastFinalAt = Date.now();
  noteSystemText(msg.text);
  lastSysInterim = '';
  lastSysVoiceAt = Date.now();
  const spk = settings.diarize && Number.isInteger(msg.spk) ? msg.spk : null;
  send('utterance', { id: msg.id, en: msg.text, final: true, spk });
  const prior = history.slice();
  history.push(msg.text);
  history = history.slice(-12);

  llm.warmup(settings);

  // Bản dịch hiện ngay theo từng đoạn. Có thời gian chờ tối đa; quá hạn thì bỏ qua thay vì hiện muộn.
  const tt0 = Date.now();
  const es = eff();
  pendingTranslations += 1;

  // Bản nháp: dịch chính chạy DeepSeek (~1 s) thì chạy thêm model local (~0,25 s) để hiện chữ tiếng Việt sớm;
  // bản DeepSeek về sẽ thay thế. Nháp về sau bản chính thì bỏ.
  let finalDone = false;
  let draftP = null;
  // Có bản dịch đoán trước đúng y câu này: dùng luôn, không gọi lại.
  const hit = spec && spec.id === msg.id && spec.key === normKey(msg.text) ? spec : null;
  if (spec && spec.id === msg.id && !hit) slog.event('spec_miss', { id: msg.id, spec: spec.text.slice(0, 200), final: msg.text.slice(0, 200) });
  if (spec && spec.id === msg.id) spec = null;
  if (hit) {
    slog.event('spec_hit', { id: msg.id, ahead_ms: Date.now() - hit.t0, ready: hit.vi !== null });
    prog = null;
  } else if (es.provider === 'deepseek' && settings.localDraft !== false && settings.ollamaModel) {
    const dt0 = Date.now();
    // Đã dịch nháp sẵn các câu đầu trong lúc người kia còn đang nói: chỉ dịch nốt phần đuôi rồi ghép lại.
    const pd = prog && prog.id === msg.id && prog.vi && msg.text.startsWith(prog.prefix) ? prog : null;
    const tail = pd ? msg.text.slice(pd.prefix.length).trim() : '';
    if (pd && !tail) draftP = Promise.resolve({ vi: pd.vi });
    else if (pd) {
      draftP = llm
        .translate({ ...es, provider: 'ollama' }, prior.concat(pd.prefix), tail)
        .then((d) => ({ ...d, vi: `${pd.vi} ${d.vi}`.trim() }));
    } else draftP = llm.translate({ ...es, provider: 'ollama' }, prior, msg.text);
    prog = null;
    draftP
      .then((d) => {
        if (finalDone) return;
        slog.event('translate_draft', { id: msg.id, ms: Date.now() - dt0, vi: d.vi });
        send('translation', { id: msg.id, vi: d.vi, draft: true });
      })
      .catch(() => {});
  }

  (hit ? hit.p : translateWithFallback(es, prior, msg.text, draftP))
    .then((out) => {
      finalDone = true;
      const ms = Date.now() - tt0;
      noteTranslate(out.provider, ms, false);
      if (out.fellBack) {
        setBanner('llm', 'warn', 'Không gọi được DeepSeek cho phần dịch (mất mạng/hết tiền/quá tải?): đang dùng model local tạm thời.');
      } else {
        noteLlmResult(true);
      }
      console.log(`[llm] translate ${out.usage ? out.usage.total_tokens : '?'} tok, ${ms}ms (${out.provider}${out.fellBack ? ', du phong' : ''})`);
      slog.event('translate', {
        id: msg.id,
        ms,
        provider: out.provider,
        fell_back: !!out.fellBack,
        vi: out.vi,
        tokens: out.usage && out.usage.total_tokens,
        tok_in: out.usage && out.usage.prompt_tokens,
        tok_out: out.usage && out.usage.completion_tokens,
        cache_hit: out.usage && out.usage.prompt_cache_hit_tokens,
        cache_miss: out.usage && out.usage.prompt_cache_miss_tokens,
        spec: !!hit,
      });
      send('translation', { id: msg.id, vi: out.vi, usage: out.usage });
    })
    .catch((e) => {
      finalDone = true;
      const ms = Date.now() - tt0;
      noteTranslate(es.provider, ms, true);
      if (!e.timeout) noteLlmResult(false, niceError(e));
      console.error('[llm] translate', e.message);
      slog.event('translate_error', { id: msg.id, ms, provider: es.provider, error: e.message, timeout: !!e.timeout });
      send('translation', { id: msg.id, vi: '', error: e.timeout ? 'Dịch quá chậm, đã bỏ qua' : niceError(e) });
    })
    .finally(() => {
      pendingTranslations -= 1;
    });

  // Đổi người nói = hết lượt của người trước (không chờ im lặng): chốt lượt đó ngay.
  if (turn && spk !== null && turn.spk !== spk) {
    clearTurnTimer();
    runSuggest(true);
    turn = null; // phòng khi runSuggest không đóng (đã gợi ý hết)
  }

  // Gom đoạn vào lượt nói hiện tại.
  if (!turn) {
    // Lượt mới: KHÔNG huỷ gợi ý cũ và không xoá bộ gợi ý trên màn hình (bạn đọc rồi trả lời sau).
    turn = { no: ++turnSeq, spk, segs: [], startedAt: Date.now(), lastSuggestAt: 0, suggested: 0 };
    send('replies-wait', { id: msg.id, turnNo: turn.no });
  }
  turn.segs.push({ id: msg.id, text: msg.text });
  clearTurnTimer();

  // Deepgram Flux đã tự quyết là hết lượt: gợi ý ngay, không chờ thêm.
  if (msg.end_of_turn) {
    runSuggest(true);
    return;
  }

  // Lượt rất dài: cập nhật gợi ý giữa chừng để không phải chờ hết bài.
  if (Date.now() - Math.max(turn.startedAt, turn.lastSuggestAt) >= MID_TURN_MS) runSuggest(false);

  // Vừa nghe xong một câu hỏi trọn vẹn: bắt đầu gợi ý ngay, không chờ thêm ~0,5 s xem họ có nói tiếp không. Nếu họ nói tiếp thì
  // hết lượt sẽ gợi ý lại cho cả lượt (gợi ý mới thay gợi ý sớm).
  if (endsWithQuestion(msg.text) && turn.suggested !== turn.segs.length) {
    slog.event('turn_early_question', { turn: turn.no, text: msg.text.slice(-160) });
    runSuggest(false);
  }

  armTurnTimer();
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  send('click-through', clickThrough);
}

// ---- Nút ghi log phiên ----
function logMeta() {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    settings: settingsStore.publicView(settings),
    gpu: lastGpu,
    note: 'Log chứa nội dung câu nói và gợi ý; không chứa API key.',
  };
}

function broadcastLogState() {
  const st = slog.state();
  send('log-state', st);
  if (st.on) setBanner('log', 'info', `Đang ghi log tại ${st.dir}${settings.logAudio ? ' (kèm âm thanh WAV)' : ''}`);
  else clearBanner('log');
}

// Bản đóng gói ghi log vào thư mục cấu hình (không nằm trong dist, nơi mỗi lần build lại bị xoá sạch);
// bản chạy bằng npm start ghi vào <thư mục dự án>\logs. Đặt logDir trong settings.json để đổi.
function logsBaseDir() {
  if (settings.logDir) return settings.logDir;
  return app.isPackaged ? path.join(app.getPath('userData'), 'logs') : path.join(app.getAppPath(), 'logs');
}

function startLog() {
  const base = logsBaseDir();
  let ok = slog.start(base, logMeta());
  if (!ok) ok = slog.start(path.join(app.getPath('userData'), 'logs'), logMeta());
  if (ok) {
    pollGpu();
    pushSttConfig(); // bật/tắt lưu WAV theo cài đặt
  }
  broadcastLogState();
  return slog.state();
}

function stopLog() {
  slog.stop();
  pushSttConfig();
  broadcastLogState();
  return slog.state();
}

// Trạng thái nghe do giao diện báo. Khi đã dừng, main bỏ mọi âm thanh còn sót (phòng khi có luồng thu rò rỉ)
// và ghi lại để biết, thay vì lặng lẽ vẫn nhận dạng và gợi ý.
let listening = false;
let strayAudio = 0;

ipcMain.on('listen:set', (_e, on) => {
  listening = !!on;
  strayAudio = 0;
  if (listening) {
    if (useDeepgram()) openDeepgram();
    llm.prewarmNet(settings); // mở sẵn kết nối DeepSeek để câu đầu không phải bắt tay
    llm.warmup(settings);
    return;
  }
  // Dừng nghe: bỏ lượt nói đang dở, huỷ gợi ý đang chờ/đang chạy, báo Whisper bỏ phần âm thanh đang gom.
  closeDeepgram();
  spec = null;
  clearTurnTimer();
  turn = null;
  if (suggestAbort) suggestAbort.abort();
  send('replies-wait', { id: -1, stopped: true });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ reset: true }));
  if (micWs && micWs.readyState === WebSocket.OPEN) micWs.send(JSON.stringify({ reset: true }));
});

ipcMain.on('audio', (_e, buf) => {
  if (!listening) {
    strayAudio += 1;
    if (strayAudio === 1) slog.event('warn', { what: 'audio_while_stopped' });
    return;
  }
  if (useDeepgram()) {
    if (dg) dg.send(Buffer.from(buf));
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(buf));
});
ipcMain.on('audio:mic', (_e, buf) => {
  if (!listening || !settings.micEnabled) return;
  if (micWs && micWs.readyState === WebSocket.OPEN) micWs.send(Buffer.from(buf));
});
ipcMain.handle('settings:get', () => settingsStore.publicView(settings));
ipcMain.handle('settings:save', (_e, patch) => {
  const sttChanged = ['whisperDir', 'whisperModel', 'whisperDevice', 'sttEngine', 'nemotronDir', 'micEnabled', 'micEngine'].some((k) => k in patch && patch[k] !== settings[k]) ||
    (typeof patch.deepgramKey === 'string' && patch.deepgramKey !== '' && useDeepgram());
  settings = settingsStore.save(patch);
  if ('provider' in patch || 'ollamaModel' in patch || 'suggestProvider' in patch || 'localDraft' in patch) {
    llm.resetWarmup();
    llm.warmup(settings);
  }
  if (typeof patch.opacity === 'number') win.setOpacity(settings.opacity);
  if (sttChanged) startSidecar();
  else pushSttConfig();
  if (slog.isOn()) slog.event('settings_changed', { keys: Object.keys(patch).filter((k) => k !== 'deepseekKey' && k !== 'deepgramKey') });
  return settingsStore.publicView(settings);
});
ipcMain.handle('ollama:models', async () => {
  try { return await llm.listOllamaModels(); } catch { return []; }
});
ipcMain.handle('log:toggle', () => (slog.isOn() ? stopLog() : startLog()));
ipcMain.handle('log:state', () => slog.state());
ipcMain.on('log:open-folder', () => {
  const dir = slog.dir || logsBaseDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.on('log:event', (_e, type, data) => {
  if (['copy', 'listen'].includes(type)) slog.event(`ui_${type}`, data && typeof data === 'object' ? data : {});
});
ipcMain.on('speaker:me', (_e, spk) => {
  meSpk = Number.isInteger(spk) ? spk : null;
  slog.event('speaker_me', { spk: meSpk });
  send('speaker-me', meSpk);
});
ipcMain.on('history:clear', () => {
  meSpk = null;
  send('speaker-me', null);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ reset_speakers: true }));
  history = [];
  priorTurns = [];
  turn = null;
  clearTurnTimer();
  if (suggestAbort) suggestAbort.abort();
});
ipcMain.on('window:close', () => app.quit());
ipcMain.on('window:minimize', () => win.minimize());
ipcMain.on('window:click-through', toggleClickThrough);

// Chỉ cho một bản chạy: hai bản sẽ tranh VRAM và cổng.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let gpuTimer = null;
app.whenReady().then(async () => {
  settings = settingsStore.load();
  setupLoopback();
  createWindow();
  await cleanupOrphan();
  startSidecar();
  llm.warmup(settings);
  pollGpu();
  gpuTimer = setInterval(pollGpu, 10000);
  globalShortcut.register('Control+Alt+T', toggleClickThrough);
});

app.on('will-quit', () => {
  clearInterval(gpuTimer);
  globalShortcut.unregisterAll();
  slog.stop();
  stopSidecar();
});
app.on('window-all-closed', () => app.quit());
