// Thử Deepgram Flux trên các đoạn WAV đã lưu trong log (bật 📝 + "lưu cả âm thanh"), so với chữ của engine đã dùng lúc ghi.
// Chạy:  npx electron scripts/bench-deepgram.js logs/session-XXXX [logs/session-YYYY ...] [--max 20]
// Key lấy từ Cài đặt của app (đã mã hoá) hoặc biến môi trường DEEPGRAM_API_KEY. Gửi âm thanh theo thời gian thực
// (mỗi đoạn + 2 s im lặng), nên chạy mất bằng tổng độ dài âm thanh. Chi phí: tính theo số phút âm thanh đã gửi.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

app.setName('live-interpreter');
app.setPath('userData', path.join(app.getPath('appData'), 'live-interpreter'));

const args = process.argv.slice(2).filter((a) => !a.endsWith('.js') && a !== '.');
const maxIdx = args.indexOf('--max');
const MAX = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 15;
const dirs = args.filter((a, i) => !a.startsWith('--') && (maxIdx < 0 || i !== maxIdx + 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readWav(file) {
  const b = fs.readFileSync(file);
  // tìm khối "data"
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  throw new Error('WAV không có khối data: ' + file);
}

function lastVoiced(pcm) {
  // chỉ số mẫu cuối của khung 50 ms có RMS > 0,008 (cùng ngưỡng VAD của app)
  const n = pcm.length / 2;
  const W = 800;
  for (let end = n; end > W; end -= W) {
    let sum = 0;
    for (let i = end - W; i < end; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    if (Math.sqrt(sum / W) > 0.008) return end;
  }
  return n;
}

function norm(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}
function wordDiff(ref, hyp) {
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] === h[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return { err: d[h.length], n: r.length };
}

app.whenReady().then(async () => {
  let key = process.env.DEEPGRAM_API_KEY || '';
  let glossary = '';
  try {
    const s = require('../src/main/settings').load();
    if (!key) key = s.deepgramKey;
    glossary = s.glossary || '';
  } catch (e) {
    console.error('Không đọc được cài đặt:', e.message);
  }
  if (!key) {
    console.error('Chưa có key Deepgram: nhập trong Cài đặt của app (chọn Deepgram) hoặc đặt DEEPGRAM_API_KEY.');
    app.exit(2);
    return;
  }
  const { DeepgramFlux, parseKeyterms } = require('../src/main/deepgram');

  const items = [];
  for (const d of dirs) {
    const ev = fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const kind = process.argv.includes('--mic') ? 'mic_final' : 'stt_final'; // --mic: thử trên giọng của bạn (micro)
    const finals = ev.filter((e) => e.type === kind && e.wav && fs.existsSync(e.wav)).slice(0, MAX);
    for (const e of finals) items.push({ dir: path.basename(d), id: e.id, ref: e.text, wav: e.wav });
  }
  if (!items.length) {
    console.error('Không có file WAV nào trong các phiên đã chọn.');
    app.exit(2);
    return;
  }

  let cur = null; // đoạn đang gửi
  const events = [];
  const dg = new DeepgramFlux({
    key,
    onMessage: (m) => events.push({ t: Date.now(), m, cur }),
    onState: (st, info) => {
      if (st !== 'open') console.log('[deepgram]', st, JSON.stringify(info || {}));
    },
  });
  dg.open({ eagerEot: 0.5, keyterms: parseKeyterms(glossary) });
  for (let i = 0; i < 50 && !dg.isOpen(); i++) await sleep(100);
  if (!dg.isOpen()) {
    console.error('Không kết nối được Deepgram.');
    app.exit(3);
    return;
  }

  const CHUNK = 2560; // 80 ms PCM16 16 kHz (Flux khuyên 80 ms)
  const silence = Buffer.alloc(CHUNK);
  const rows = [];
  for (const it of items) {
    const pcm = readWav(it.wav);
    cur = it;
    const start = Date.now();
    for (let o = 0; o < pcm.length; o += CHUNK) {
      dg.send(pcm.subarray(o, o + CHUNK));
      await sleep(80);
    }
    // File WAV đã kèm ~0,5 s im lặng cuối (lúc ghi cần im lặng mới chốt câu): tính mốc dứt tiếng từ khung có tiếng cuối cùng.
    it.speechEnd = Date.now() - (pcm.length / 2 - lastVoiced(pcm)) / 16;
    for (let k = 0; k < 25; k++) {
      dg.send(silence);
      await sleep(80);
    }
    const mine = events.filter((e) => e.cur === it);
    const finals = mine.filter((e) => e.m.type === 'final');
    const lastFinal = finals[finals.length - 1];
    const eager = mine.filter((e) => e.m.type === 'pause').pop();
    const text = finals.map((e) => e.m.text).join(' ');
    const { err, n } = wordDiff(it.ref, text);
    rows.push({
      ...it,
      dg: text,
      eot_ms: lastFinal ? lastFinal.t - it.speechEnd : null,
      eager_ms: eager ? eager.t - it.speechEnd : null,
      eager_same: eager && lastFinal ? norm(eager.m.text).join(' ') === norm(lastFinal.m.text).join(' ') : null,
      turns: finals.length,
      err,
      n,
      wall: Date.now() - start,
    });
    const r = rows[rows.length - 1];
    console.log(`\n[${it.dir} #${it.id}] hết lượt sau ${r.eot_ms ?? '—'} ms (eager ${r.eager_ms ?? '—'} ms)${r.turns > 1 ? `, chia ${r.turns} lượt` : ''}`);
    console.log('  cũ: ' + it.ref);
    console.log('  DG : ' + (text || '(không ra chữ)'));
  }
  dg.close();
  await sleep(500);

  const ok = rows.filter((r) => r.eot_ms !== null);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : '—');
  const p50 = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : '—');
  const eot = ok.map((r) => r.eot_ms);
  const eag = rows.filter((r) => r.eager_ms !== null).map((r) => r.eager_ms);
  const errs = rows.reduce((x, r) => x + r.err, 0);
  const words = rows.reduce((x, r) => x + r.n, 0);
  console.log('\n==== Tổng kết ====');
  console.log(`Đoạn: ${rows.length} | có hết lượt: ${ok.length} | bị chia nhiều lượt: ${rows.filter((r) => r.turns > 1).length}`);
  console.log(`Hết lượt (EndOfTurn) sau khi dứt tiếng: TB ${avg(eot)} ms, p50 ${p50(eot)} ms`);
  console.log(`Báo sớm (EagerEndOfTurn): TB ${avg(eag)} ms, p50 ${p50(eag)} ms | chữ báo sớm = chữ chốt: ${rows.filter((r) => r.eager_same).length}/${eag.length}`);
  console.log(`Khác chữ so với engine cũ: ${errs}/${words} từ = ${words ? ((100 * errs) / words).toFixed(1) : 0}% (gồm cả khác cách viết số, dấu câu bỏ qua)`);
  console.log(`Âm thanh đã gửi: ${(dg.audioSec / 60).toFixed(2)} phút`);
  app.exit(0);
});
