const $ = (id) => document.getElementById(id);
const feed = $('feed');
const cards = $('cards');

let sttState = 'loading';
let listening = false;
let tokenTotal = 0;
const blocks = new Map(); // id -> { root, enWrap, en, vi, chip, spk }
let meSpk = null; // người nói được đánh dấu là bạn
const spkLetter = (n) => String.fromCharCode(65 + (n % 26));
let latestId = -1;

function setStatus(state, message) {
  sttState = state;
  $('statusText').textContent = message;
  $('dot').className = 'dot ' + (listening ? 'live' : state);
}

function ensureBlock(id) {
  let b = blocks.get(id);
  if (b) return b;
  feed.querySelector('.empty')?.remove();
  const root = document.createElement('div');
  root.className = 'utt interim';
  const enWrap = document.createElement('div'); // chứa nhãn người nói (nếu có) + chữ tiếng Anh
  enWrap.className = 'en';
  const en = document.createElement('span');
  enWrap.append(en);
  const vi = document.createElement('div');
  vi.className = 'vi';
  root.append(enWrap, vi);
  feed.appendChild(root);
  b = { root, enWrap, en, vi, chip: null, spk: null };
  blocks.set(id, b);
  return b;
}

function scrollDown() {
  feed.scrollTop = feed.scrollHeight;
}

// Nhiều người nói: nhãn A, B, C… trước mỗi câu; bấm để đánh dấu "đây là tôi" (bấm lại để bỏ).
function applyMe() {
  for (const b of blocks.values()) {
    const me = b.spk !== null && b.spk === meSpk;
    b.root.classList.toggle('me', me);
    if (b.chip) b.chip.classList.toggle('me', me);
  }
}

function setSpeaker(b, spk) {
  if (spk === null || spk === undefined || b.chip) return;
  b.spk = spk;
  const chip = document.createElement('span');
  chip.className = `chip s${spk % 8}`;
  chip.textContent = spkLetter(spk);
  chip.title = 'Bấm để đánh dấu "đây là tôi" (không gợi ý cho lời của bạn). Bấm lại để bỏ.';
  chip.addEventListener('click', () => window.api.setMeSpeaker(meSpk === spk ? null : spk));
  b.chip = chip;
  b.enWrap.prepend(chip);
  applyMe();
}

window.api.onSpeakerMe((spk) => {
  meSpk = Number.isInteger(spk) ? spk : null;
  applyMe();
});

window.api.onUtterance(({ id, en, final, nonEnglish, spk, dropped, me }) => {
  if (dropped) {
    // Đoạn bị bỏ (nhiễu, quá ngắn, không ra chữ): xoá dòng chữ tạm đã hiện, nếu có.
    const old = blocks.get(id);
    if (old) {
      old.root.remove();
      blocks.delete(id);
    }
    return;
  }
  const b = ensureBlock(id);
  if (me) {
    // Lời của bạn (micro): chỉ hiện chữ tiếng Anh, không dịch, không gợi ý.
    if (!b.chip) {
      const chip = document.createElement('span');
      chip.className = 'chip mine';
      chip.textContent = 'Tôi';
      b.chip = chip;
      b.enWrap.prepend(chip);
      b.root.classList.add('me', 'mine');
    }
    b.en.textContent = en;
    b.root.classList.toggle('interim', !final);
    if (final) b.done = true;
    scrollDown();
    return;
  }
  if (final) setSpeaker(b, spk);
  if (nonEnglish) {
    // Không phải tiếng Anh: giữ chữ để biết app nghe được gì, nhưng mờ đi và không dịch/gợi ý.
    b.en.textContent = en;
    b.root.classList.remove('interim');
    b.root.classList.add('skipped');
    b.vi.textContent = 'Không phải tiếng Anh — đã bỏ qua';
    b.vi.className = 'vi skip';
    b.done = true;
    scrollDown();
    return;
  }
  b.en.textContent = en;
  b.root.classList.toggle('interim', !final);
  if (final) {
    b.vi.textContent = '…';
    latestId = id;
  }
  scrollDown();
});

function addUsage(usage) {
  if (!usage) return;
  tokenTotal += usage.total_tokens || 0;
  $('usage').textContent = `${tokenTotal.toLocaleString()} token`;
}

window.api.onTranslation(({ id, vi, usage, error, draft }) => {
  const b = ensureBlock(id);
  if (draft) {
    // Bản nháp từ model local: hiện sớm, mờ và nghiêng; bản chính từ DeepSeek sẽ thay thế.
    if (b.done) return;
    b.vi.textContent = vi;
    b.vi.className = 'vi draft';
    b.vi.title = 'Bản nháp nhanh, đang chờ bản dịch chính xác';
    scrollDown();
    return;
  }
  b.done = true;
  b.vi.title = '';
  if (error) {
    if (b.vi.classList.contains('draft')) {
      b.vi.title = `Chỉ có bản nháp (${error})`; // giữ bản nháp còn hơn không có gì
    } else {
      b.vi.textContent = error;
      b.vi.className = 'vi err';
    }
  } else {
    b.vi.textContent = vi;
    b.vi.className = 'vi';
  }
  addUsage(usage);
  scrollDown();
});

// Gợi ý xếp chồng theo từng LƯỢT NÓI của người kia (bạn đọc rồi trả lời sau, nên bộ gợi ý cũ không được biến mất khi họ nói tiếp).
// Bộ mới nhất mở sẵn; các bộ cũ thu gọn thành một dòng "↳ câu của họ", bấm để mở lại.
const MAX_GROUPS = 5;
const groups = new Map(); // turnNo -> { root, head, body, id }

function setSgStatus(text) {
  $('sgStatus').textContent = text || '';
}

function ensureGroup(turnNo, q) {
  let g = groups.get(turnNo);
  if (g) return g;
  const root = document.createElement('div');
  root.className = 'sg-group';
  const head = document.createElement('div');
  head.className = 'sg-head';
  head.title = 'Bấm để mở/thu gọn';
  head.addEventListener('click', () => root.classList.toggle('collapsed'));
  const body = document.createElement('div');
  body.className = 'sg-body';
  root.append(head, body);
  g = { root, head, body, id: -1 };
  groups.set(turnNo, g);
  // Thu gọn các bộ cũ, đặt bộ mới lên đầu, giữ tối đa MAX_GROUPS bộ.
  for (const other of groups.values()) if (other !== g) other.root.classList.add('collapsed');
  cards.prepend(root);
  while (groups.size > MAX_GROUPS) {
    const [oldKey, old] = groups.entries().next().value;
    old.root.remove();
    groups.delete(oldKey);
  }
  return g;
}

function setGroupNote(g, text) {
  g.body.textContent = '';
  const none = document.createElement('div');
  none.className = 'none';
  none.textContent = text;
  g.body.appendChild(none);
}

window.api.onRepliesWait(({ stopped }) => {
  setSgStatus(stopped ? 'Đã dừng nghe.' : 'Đang nghe người kia nói…');
});

window.api.onRepliesStart(({ id, turnNo, expected, q, spk }) => {
  setSgStatus('');
  const g = ensureGroup(turnNo, q);
  g.id = id; // chỉ nhận gợi ý của lần chạy mới nhất cho lượt này (bộ mid-turn bị thay bằng bộ cuối lượt)
  g.head.textContent = '↳ ' + (Number.isInteger(spk) ? `[${spkLetter(spk)}] ` : '') + (q || '');
  g.root.classList.remove('collapsed');
  setGroupNote(g, expected ? 'Đang nghĩ gợi ý…' : 'Câu này không cần trả lời.');
});

window.api.onReply(({ id, turnNo, en, vi, warn }) => {
  const g = groups.get(turnNo);
  if (!g || g.id !== id) return;
  g.body.querySelector('.none')?.remove();
  const c = document.createElement('div');
  c.className = 'card';
  const enEl = document.createElement('div');
  enEl.className = 'en';
  enEl.textContent = en;
  const viEl = document.createElement('div');
  viEl.className = 'vi';
  viEl.textContent = vi || '';
  c.append(enEl, viEl);
  if (warn && warn.length) {
    // Gợi ý có chi tiết bạn chưa khai (con số, kinh nghiệm, thành tích): nhắc kiểm tra trước khi nói.
    const w = document.createElement('div');
    w.className = 'warn';
    w.textContent = `⚠ Chi tiết bạn chưa khai: ${warn.join('; ')}. Kiểm tra trước khi nói.`;
    c.append(w);
    c.classList.add('flagged');
  }
  c.title = 'Bấm để copy câu tiếng Anh';
  c.addEventListener('click', () => {
    window.api.logEvent('copy', { id, turnNo, en, vi });
    navigator.clipboard.writeText(en).then(() => {
      c.classList.add('copied');
      setTimeout(() => c.classList.remove('copied'), 900);
    });
  });
  g.body.appendChild(c);
});

window.api.onRepliesEnd(({ id, turnNo, count, usage, error }) => {
  addUsage(usage);
  const g = groups.get(turnNo);
  if (!g || g.id !== id || count > 0) return;
  setGroupNote(g, error ? `Lỗi gợi ý: ${error}` : 'Không có gợi ý cho câu này.');
});

// Toàn bộ tài nguyên thu âm của MỘT lần nghe, để dừng là dọn sạch được (không để sót luồng chạy ngầm).
let capture = null; // { stream, ctx, src, node }
let starting = false;

function teardownCapture() {
  const c = capture;
  capture = null;
  if (!c) return;
  try { c.node.port.onmessage = null; } catch { /* bỏ qua */ }
  try { c.src.disconnect(); } catch { /* bỏ qua */ }
  try { c.node.disconnect(); } catch { /* bỏ qua */ }
  c.stream.getTracks().forEach((t) => t.stop());
  c.ctx.close().catch(() => {});
  if (c.mic) {
    try { c.mic.node.port.onmessage = null; } catch { /* bỏ qua */ }
    try { c.mic.src.disconnect(); } catch { /* bỏ qua */ }
    c.mic.stream.getTracks().forEach((t) => t.stop());
    c.mic.ctx.close().catch(() => {});
    c.mic = null;
  }
}

async function startListening() {
  // Bấm hai lần liên tiếp từng tạo ra hai luồng thu âm song song, chỉ luồng sau bị dừng khi bấm Dừng.
  if (listening || starting) return;
  if (sttState !== 'ready') {
    alert('Công cụ nhận dạng giọng nói chưa sẵn sàng. Xem trạng thái ở góc trên bên trái.');
    return;
  }
  starting = true;
  $('btnListen').disabled = true;
  teardownCapture(); // dọn mọi thứ còn sót từ lần trước
  let c = null;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    c = { stream, ctx: null, src: null, node: null };
    capture = c;
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('Không có luồng âm thanh hệ thống');
    c.ctx = new AudioContext({ sampleRate: 16000 });
    await c.ctx.audioWorklet.addModule('worklet.js');
    c.src = c.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    c.node = new AudioWorkletNode(c.ctx, 'pcm-processor');
    c.node.port.onmessage = (e) => {
      if (capture === c) window.api.sendAudio(e.data); // chỉ gửi khi đây còn là luồng đang dùng
    };
    c.src.connect(c.node);
    // Micro của bạn (tuỳ chọn): luồng riêng, gửi qua kênh riêng để main biết đây là lời của bạn.
    const st = await window.api.getSettings().catch(() => ({}));
    if (st && st.micEnabled) {
      try {
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        const m = { stream: ms, ctx: new AudioContext({ sampleRate: 16000 }) };
        await m.ctx.audioWorklet.addModule('worklet.js');
        m.src = m.ctx.createMediaStreamSource(ms);
        m.node = new AudioWorkletNode(m.ctx, 'pcm-processor');
        m.node.port.onmessage = (e) => {
          if (capture === c) window.api.sendMicAudio(e.data);
        };
        m.src.connect(m.node);
        c.mic = m;
      } catch (e) {
        setStatus(sttState, 'Không mở được micro: ' + e.message);
      }
    }
    listening = true;
    $('btnListen').textContent = '■ Dừng';
    setStatus(sttState, 'Đang nghe…');
    window.api.setListening(true);
    window.api.logEvent('listen', { on: true });
  } catch (e) {
    teardownCapture();
    setStatus('error', 'Không thu được âm thanh: ' + e.message);
  } finally {
    starting = false;
    $('btnListen').disabled = false;
  }
}

function stopListening() {
  teardownCapture();
  listening = false;
  $('btnListen').textContent = '▶ Bắt đầu nghe';
  setStatus(sttState, 'Đã dừng');
  window.api.setListening(false); // main bỏ âm thanh còn sót, huỷ gợi ý đang chờ
  window.api.logEvent('listen', { on: false });
}

$('btnListen').addEventListener('click', () => (listening ? stopListening() : startListening()));
$('btnClear').addEventListener('click', () => {
  feed.textContent = '';
  blocks.clear();
  groups.clear();
  meSpk = null;
  cards.textContent = '';
  setSgStatus('');
  window.api.clearHistory();
});
$('btnThrough').addEventListener('click', () => window.api.toggleClickThrough());
$('btnMin').addEventListener('click', () => window.api.minimize());
$('btnClose').addEventListener('click', () => window.api.close());
window.api.onStatus(({ state, message }) => setStatus(state, message));

// Banner cảnh báo từ main (GPU nghẽn, VRAM đầy, AI lỗi, đang ghi log…)
window.api.onBanner((list) => {
  const box = $('banners');
  box.textContent = '';
  for (const b of list) {
    const d = document.createElement('div');
    d.className = `banner ${b.level}`;
    d.textContent = b.text;
    box.appendChild(d);
  }
});

// Nút ghi log phiên
function renderLogState(st) {
  const btn = $('btnLog');
  btn.classList.toggle('rec', !!st.on);
  btn.textContent = st.on ? '● Log' : '📝';
  btn.title = st.on
    ? `Đang ghi log: ${st.dir}\nBấm để dừng`
    : 'Bật ghi log phiên (lưu câu nói, bản dịch, gợi ý, thời gian ra file để kiểm tra)';
}
window.api.onLogState(renderLogState);
window.api.logState().then(renderLogState);
// ---- Chế độ: trò chuyện thật / luyện với gia sư (đổi bằng một cú bấm ở thanh trên) ----
let mode = 'chat';
function renderMode(m) {
  mode = m === 'tutor' ? 'tutor' : 'chat';
  const b = $('btnMode');
  b.textContent = mode === 'tutor' ? '🎓 Gia sư' : '🗣 Trò chuyện';
  b.classList.toggle('on', mode === 'tutor');
}
// ---- Công cụ nhận dạng: Nemotron trên máy (mặc định) / Deepgram khi cần ----
let engine = 'nemotron';
let localEngine = 'nemotron'; // engine trên máy để quay về (whisper hoặc nemotron)
function renderEngine(e) {
  engine = e || 'nemotron';
  if (engine !== 'deepgram') localEngine = engine;
  const b = $('btnEngine');
  b.textContent = engine === 'deepgram' ? '☁ Deepgram' : '💻 Máy';
  b.classList.toggle('on', engine === 'deepgram');
}
window.api.getSettings().then((s) => {
  renderMode(s && s.mode);
  renderEngine(s && s.sttEngine);
}).catch(() => {});
$('btnEngine').addEventListener('click', async () => {
  const next = engine === 'deepgram' ? localEngine : 'deepgram';
  if (listening) stopListening(); // đổi công cụ thì khởi động lại phần nhận dạng: dừng nghe trước
  renderEngine(next);
  const s = await window.api.saveSettings({ sttEngine: next });
  if (s && s.sttEngine) renderEngine(s.sttEngine);
});
$('btnMode').addEventListener('click', async () => {
  const next = mode === 'tutor' ? 'chat' : 'tutor';
  renderMode(next);
  const s = await window.api.saveSettings({ mode: next });
  if (s && s.mode) renderMode(s.mode);
});
$('btnLog').addEventListener('click', async () => renderLogState(await window.api.toggleLog()));
$('btnOpenLogs').addEventListener('click', () => window.api.openLogFolder());
window.api.onClickThrough((on) => $('btnThrough').classList.toggle('on', on));

// ---- Cài đặt ----
const FIELDS = ['provider', 'suggestProvider', 'deepseekModel', 'ollamaModel', 'style', 'replyLength', 'replyLevel', 'persona', 'mode', 'context', 'contextChat', 'glossary', 'speakerThreshold', 'sttEngine', 'micEngine', 'nemotronDir', 'whisperDevice', 'whisperModel', 'whisperDir', 'silenceMs', 'turnEndMs', 'vadThreshold'];

function syncProviderRows() {
  const translate = $('provider').value;
  const sp = $('suggestProvider').value;
  const suggest = sp === 'same' ? translate : sp;
  const usesDeepseek = translate === 'deepseek' || suggest === 'deepseek';
  const usesOllama = translate === 'ollama' || suggest === 'ollama';
  $('rowKey').hidden = !usesDeepseek;
  $('rowDsModel').hidden = !usesDeepseek;
  $('rowOllama').hidden = !usesOllama;
}

async function openSettings() {
  const s = await window.api.getSettings();
  const models = await window.api.ollamaModels();
  const sel = $('ollamaModel');
  sel.textContent = '';
  const list = models.includes(s.ollamaModel) ? models : [s.ollamaModel, ...models];
  for (const m of list) sel.add(new Option(m, m));
  for (const f of FIELDS) $(f).value = s[f];
  $('interim').checked = s.interim;
  $('logAudio').checked = !!s.logAudio;
  $('diarize').checked = !!s.diarize;
  $('localDraft').checked = s.localDraft !== false;
  $('micEnabled').checked = !!s.micEnabled;
  $('deepgramKey').value = '';
  $('dgKeyHint').textContent = s.hasDeepgramKey ? '(đã lưu — để trống nếu giữ nguyên)' : '(chưa có)';
  syncEngineRows();
  $('opacity').value = s.opacity;
  $('deepseekKey').value = '';
  $('keyHint').textContent = s.hasKey ? '(đã lưu — để trống nếu giữ nguyên)' : '(chưa có)';
  syncProviderRows();
  $('settings').hidden = false;
}

function syncEngineRows() {
  $('rowDgKey').hidden = $('sttEngine').value !== 'deepgram';
}
$('sttEngine').addEventListener('change', syncEngineRows);
$('provider').addEventListener('change', syncProviderRows);
$('suggestProvider').addEventListener('change', syncProviderRows);
$('btnSettings').addEventListener('click', openSettings);
$('btnCancel').addEventListener('click', () => ($('settings').hidden = true));
$('opacity').addEventListener('input', (e) => window.api.saveSettings({ opacity: Number(e.target.value) }));
$('btnSave').addEventListener('click', async () => {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value;
  patch.silenceMs = Number(patch.silenceMs);
  patch.turnEndMs = Number(patch.turnEndMs);
  patch.vadThreshold = Number(patch.vadThreshold);
  patch.interim = $('interim').checked;
  patch.logAudio = $('logAudio').checked;
  patch.diarize = $('diarize').checked;
  patch.speakerThreshold = Number($('speakerThreshold').value) || 0.42;
  patch.localDraft = $('localDraft').checked;
  patch.micEnabled = $('micEnabled').checked;
  const dgKey = $('deepgramKey').value.trim();
  if (dgKey) patch.deepgramKey = dgKey;
  const key = $('deepseekKey').value.trim();
  if (key) patch.deepseekKey = key;
  const saved = await window.api.saveSettings(patch);
  if (saved && saved.mode) renderMode(saved.mode);
  if (saved && saved.sttEngine) renderEngine(saved.sttEngine);
  $('settings').hidden = true;
});
