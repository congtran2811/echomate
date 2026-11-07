#!/usr/bin/env node
// Tóm tắt một phiên log (JSONL) do nút 📝 ghi ra: độ trễ, chất lượng nhận dạng, lỗi, chi phí.
// Dùng: node scripts/analyze-log.js [thư-mục-phiên | events.jsonl] [--details]
// Không đối số: lấy phiên mới nhất trong <app>/logs.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const details = args.includes('--details');
let target = args.find((a) => !a.startsWith('--'));
const logsDir = path.join(__dirname, '..', 'logs');

if (!target) {
  // Tìm ở cả hai nơi app ghi log: <dự án>\logs (npm start) và %APPDATA%\live-interpreter\logs (bản đóng gói).
  const roots = [logsDir, path.join(process.env.APPDATA || '', 'live-interpreter', 'logs')].filter((d) => fs.existsSync(d));
  if (!roots.length) fail('Chưa có thư mục logs. Bật nút 📝 trong app để ghi log.');
  // Phiên sao lưu từ bản đóng gói có tiền tố "built-": vẫn tính, sắp theo thời gian trong tên.
  const all = roots.flatMap((r) => fs.readdirSync(r).filter((d) => /^(built-)?session-/.test(d)).map((d) => path.join(r, d)));
  const key = (p) => path.basename(p).replace(/^built-/, '');
  const sessions = all.sort((a, b) => key(a).localeCompare(key(b)));
  if (!sessions.length) fail('Chưa có phiên log nào.');
  target = sessions[sessions.length - 1];
}
const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'events.jsonl') : target;
if (!fs.existsSync(file)) fail(`Không thấy ${file}`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const ev = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const by = (type) => ev.filter((e) => e.type === type);
const nums = (arr) => arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : NaN);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const stat = (a, unit = '', d = 0) =>
  a.length ? `TB ${f(avg(a), d)}${unit} | p50 ${f(pct(a, 50), d)} | p95 ${f(pct(a, 95), d)} | max ${f(a[a.length - 1], d)} (n=${a.length})` : 'không có dữ liệu';
const line = (t) => console.log(t);
const h = (t) => console.log(`\n== ${t} ==`);

const start = by('session_start')[0];
const end = by('session_end')[0];
line(`Phiên: ${path.dirname(file)}`);
if (start) {
  const s = start.settings || {};
  line(`Bắt đầu ${start.ts} | ${end ? end.seconds + ' giây' : 'chưa kết thúc (log bị cắt)'}`);
  line(`Dịch: ${s.provider} (${s.ollamaModel}) | Gợi ý: ${s.suggestProvider} (${s.deepseekModel}) | độ dài: ${s.replyLength} | Whisper: ${s.whisperModel}/${s.whisperDevice}`);
  line(`Ngưỡng âm thanh ${s.vadThreshold} | chốt câu ${s.silenceMs}ms | hết lượt ${s.turnEndMs}ms | bối cảnh: "${s.context || ''}" | thuật ngữ: "${s.glossary || ''}"`);
}

h('Nhận dạng giọng nói (Whisper)');
const finals = by('stt_final');
const empties = by('stt_empty');
const dropped = by('stt_dropped');
line(`Câu chốt: ${finals.length} | có tiếng nhưng không ra chữ: ${empties.length} | bỏ vì quá ngắn: ${dropped.length}`);
const durs = nums(finals.map((e) => e.dur));
const procs = nums(finals.map((e) => e.proc_ms));
line(`Độ dài đoạn (giây): ${stat(durs, '', 1)}`);
line(`Thời gian Whisper chốt (ms): ${stat(procs, '')}`);
const rtf = finals.filter((e) => e.dur > 0).map((e) => e.proc_ms / 1000 / e.dur);
line(`Hệ số thời gian thực (proc/dur, <1 là nhanh hơn thời gian thực): TB ${f(avg(rtf), 2)}`);
const reasons = {};
finals.forEach((e) => (reasons[e.reason] = (reasons[e.reason] || 0) + 1));
line(`Lý do cắt đoạn: ${JSON.stringify(reasons)}  (silence = im lặng; soft = cắt ở chỗ ngừng ngắn; max = cắt cứng 25s)`);
const rv = nums(finals.map((e) => e.rms_voiced));
const rq = nums(finals.map((e) => e.rms_quiet).filter((x) => x > 0));
const thr = start && start.settings ? start.settings.vadThreshold : NaN;
line(`Âm lượng giọng (rms): ${stat(rv, '', 4)} | nhiễu nền khi im: ${stat(rq, '', 4)} | ngưỡng ${thr}`);
if (Number.isFinite(thr) && rq.length && avg(rq) > thr * 0.6) line('  ⚠ Nhiễu nền gần ngưỡng: dễ cắt câu sai hoặc nhận tiếng ồn → cân nhắc tăng ngưỡng hoặc dùng VAD tốt hơn.');
if (Number.isFinite(thr) && rv.length && avg(rv) < thr * 3) line('  ⚠ Giọng nhỏ so với ngưỡng: dễ bỏ sót → cân nhắc giảm ngưỡng.');
const halluc = finals.filter((e) => /^(thank you|thanks for watching|you|bye|okay|so)\W*$/i.test(e.text.trim()) || e.text.trim().split(/\s+/).length <= 1);
if (halluc.length) line(`  ⚠ ${halluc.length} đoạn 1 từ / nghi bịa: ${halluc.slice(0, 5).map((e) => `"${e.text}"`).join(', ')}`);
const nonEn = by('stt_non_english');
if (nonEn.length) line(`Đoạn không phải tiếng Anh (đã bỏ qua, không tốn dịch/gợi ý): ${nonEn.length} — ví dụ: ${nonEn.slice(0, 3).map((e) => `"${e.text.slice(0, 40)}"`).join(', ')}`);
const withWav = finals.filter((e) => e.wav).length;
if (withWav) line(`Có ${withWav} file WAV để chạy lại (thư mục audio/ trong phiên).`);

h('Dịch từng đoạn');
const tr = by('translate');
const trErr = by('translate_error');
const trMs = nums(tr.map((e) => e.ms));
line(`Thành công ${tr.length} | lỗi ${trErr.length} (hết giờ ${trErr.filter((e) => e.timeout).length}) | thời gian (ms): ${stat(trMs)}`);
const provs = {};
tr.forEach((e) => (provs[e.provider] = (provs[e.provider] || 0) + 1));
line(`Nhà cung cấp: ${JSON.stringify(provs)}`);
const drafts = by('translate_draft');
if (drafts.length) {
  const draftMs = nums(drafts.map((e) => e.ms));
  line(`Bản nháp local: ${drafts.length}/${tr.length + trErr.length} đoạn | thời gian (ms): ${stat(draftMs)}`);
  // Bản nháp có thực sự về trước bản chính? So thời điểm hoàn thành (t) của hai sự kiện cùng id.
  const earlier = drafts.filter((d) => {
    const m = tr.find((x) => x.id === d.id);
    return m && d.t < m.t;
  });
  const gains = drafts
    .map((d) => {
      const m = tr.find((x) => x.id === d.id);
      return m ? m.t - d.t : NaN;
    })
    .filter(Number.isFinite);
  line(`  nháp về trước bản chính: ${earlier.length}/${drafts.length} | bản chính về sau nháp (ms): ${stat(nums(gains))}`);
  const diffs = drafts.filter((d) => {
    const m = tr.find((x) => x.id === d.id);
    return m && m.vi.trim() !== d.vi.trim();
  }).length;
  line(`  bản chính khác bản nháp: ${diffs}/${drafts.length} đoạn (chữ trên màn hình bị đổi ${diffs} lần)`);
  const first = nums(
    finals.map((fl) => {
      const d = drafts.find((x) => x.id === fl.id);
      const m = tr.find((x) => x.id === fl.id);
      const t = [d && d.ms, m && m.ms].filter(Number.isFinite);
      return t.length ? Math.min(...t) : NaN;
    })
  );
  const silence = start && start.settings ? start.settings.silenceMs : 500;
  line(`  => thấy chữ Việt đầu tiên sau (từ lúc dứt câu, ms): TB ${f(avg(first) + silence + avg(procs))} (im lặng ${silence} + Whisper ${f(avg(procs))} + dịch ${f(avg(first))})`);
}
trErr.slice(0, 3).forEach((e) => line(`  lỗi: ${e.error}`));
const foreign = tr.filter((e) => /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ]/.test(e.vi));
if (foreign.length) line(`  ⚠ ${foreign.length} bản dịch lẫn chữ lạ`);
const enInVi = tr.filter((e) => /\b(the|and|that|with|this|have|will)\b/i.test(e.vi));
if (enInVi.length) line(`  ⚠ ${enInVi.length} bản dịch còn lẫn từ tiếng Anh thông dụng (kiểm tra bằng --details)`);

h('Gợi ý trả lời');
const sg = by('suggest');
const sgAb = by('suggest_abort');
const sgErr = by('suggest_error');
line(`Hoàn tất ${sg.length} | bị huỷ ${sgAb.length} | lỗi ${sgErr.length} | bỏ qua (câu quá ngắn/đệm) ${by('suggest_skipped').length}`);
line(`Gợi ý đầu hiện sau (ms): ${stat(nums(sg.map((e) => e.first_ms)))}`);
line(`Đủ bộ gợi ý sau (ms): ${stat(nums(sg.map((e) => e.total_ms)))}`);
const short = sg.filter((e) => e.count < 3).length;
if (short) line(`  ⚠ ${short} lần có ít hơn 3 gợi ý`);
const turns = by('turn_suggest');
line(`Lượt nói: ${turns.filter((t) => t.mode === 'end').length} cuối lượt, ${turns.filter((t) => t.mode === 'mid').length} giữa chừng | độ dài lượt (ký tự): ${stat(nums(turns.map((t) => t.chars)))}`);
const tokIn = sg.reduce((s, e) => s + (e.tok_in || 0), 0);
const tokOut = sg.reduce((s, e) => s + (e.tok_out || 0), 0);
const usd = sg.reduce((s, e) => s + (e.usd_upper || 0), 0);
line(`Token: ${tokIn} vào + ${tokOut} ra (${sg.some((e) => e.tok_exact) ? 'có số thật' : 'ước tính'}) | chi phí cận trên ≈ $${usd.toFixed(4)}`);
sgErr.slice(0, 3).forEach((e) => line(`  lỗi: ${e.error}`));
const copies = by('ui_copy');
line(`Số lần bạn bấm copy một gợi ý: ${copies.length}`);

const withSpk = finals.filter((e) => Number.isInteger(e.spk));
if (withSpk.length) {
  h('Nhiều người nói (tách giọng)');
  const thr2 = start && start.settings ? start.settings.speakerThreshold : 0.42;
  const speakers = {};
  withSpk.forEach((e) => (speakers[e.spk] = (speakers[e.spk] || 0) + 1));
  line(`Số người phát hiện: ${Object.keys(speakers).length} | số đoạn mỗi người: ${Object.entries(speakers).map(([k, v]) => `${String.fromCharCode(65 + Number(k))}=${v}`).join(', ')} | ngưỡng ${thr2}`);
  let switches = 0;
  for (let i = 1; i < withSpk.length; i++) if (withSpk[i].spk !== withSpk[i - 1].spk) switches++;
  line(`Số lần đổi người nói: ${switches} | lần tạo người mới: ${withSpk.filter((e) => e.spk_new).length} | thời gian tính vector giọng (ms): ${stat(nums(withSpk.map((e) => e.spk_ms)))}`);
  // Độ giống với người được chọn và với người gần thứ hai: khoảng cách càng lớn càng tin cậy.
  const margins = withSpk
    .filter((e) => Array.isArray(e.spk_sims) && e.spk_sims.length >= 2)
    .map((e) => {
      const s2 = [...e.spk_sims].sort((a, b) => b - a);
      return s2[0] - s2[1];
    });
  line(`Độ giống với người được chọn: ${stat(nums(withSpk.map((e) => e.spk_sim)), '', 2)}`);
  if (margins.length) line(`Chênh lệch giữa người giống nhất và người thứ hai (càng lớn càng chắc): ${stat(nums(margins), '', 2)}`);
  const shaky = withSpk.filter((e) => !e.spk_new && Number.isFinite(thr2) && e.spk_sim - thr2 < 0.08 && e.spk_sim >= thr2);
  if (shaky.length) line(`  ⚠ ${shaky.length} đoạn gán người nhưng sát ngưỡng (độ giống < ngưỡng + 0,08) — có thể gán nhầm: ${shaky.slice(0, 3).map((e) => `"${e.text.slice(0, 30)}"(${e.spk_sim})`).join(', ')}`);
  const tooMany = Object.keys(speakers).length > 4;
  if (tooMany) line('  ⚠ Phát hiện hơn 4 người: nếu thực tế ít hơn thì giọng một người đang bị tách thành nhiều nhãn. Thử hạ ngưỡng (ví dụ 0,35) để gộp lại.');
  const me = by('speaker_me');
  if (me.length) line(`Bạn đánh dấu "đây là tôi": ${me.map((e) => (e.spk === null ? 'bỏ đánh dấu' : String.fromCharCode(65 + e.spk))).join(' → ')}`);
}

h('GPU và sự cố');
const gp = by('gpu');
if (gp.length) {
  const used = nums(gp.map((e) => e.used_mb));
  const total = gp[0].total_mb;
  const hi = gp.filter((e) => e.used_mb / e.total_mb >= 0.96).length;
  line(`VRAM: TB ${f(avg(used))} MB, max ${f(used[used.length - 1])} / ${total} MB | ${hi}/${gp.length} mẫu ≥96% (nguy cơ nghẽn)`);
  line(`GPU util: ${stat(nums(gp.map((e) => e.util)), '%')}`);
}
const warns = by('warn');
line(`Cảnh báo: ${warns.length ? warns.map((w) => w.what).join(', ') : 'không'}`);
line(`Chuyển dự phòng sang DeepSeek: ${by('fallback_on').length} lần${by('fallback_needed_no_key').length ? ` | cần dự phòng nhưng thiếu key: ${by('fallback_needed_no_key').length}` : ''}`);

h('Tối ưu mới (dịch đoán trước, cache DeepSeek, micro, Deepgram)');
{
  const hits = by('spec_hit');
  const miss = by('spec_miss');
  const cancel = by('spec_cancel');
  const starts = by('spec_start');
  line(`Dịch đoán trước: bắt đầu ${starts.length} | dùng được ${hits.length} | lệch chữ ${miss.length} | huỷ vì nói tiếp ${cancel.length}`);
  if (hits.length) line(`  bắt đầu sớm hơn lúc chốt câu: ${stat(nums(hits.map((e) => e.ahead_ms)), ' ms')} | đã có bản dịch lúc chốt: ${hits.filter((e) => e.ready).length}/${hits.length}`);
  const trs = by('translate');
  const withSpec = trs.filter((e) => e.spec).map((e) => e.ms);
  if (withSpec.length) {
    line(`  bản dịch DeepSeek hiện sau khi chốt câu: có đoán trước ${stat(nums(withSpec), ' ms')} | không đoán trước ${stat(nums(trs.filter((e) => !e.spec).map((e) => e.ms)), ' ms')}`);
    line('  (dòng "thấy chữ Việt đầu tiên" ở mục Dịch chỉ tính bản nháp local; khi đoán trước trúng thì không chạy bản nháp)');
  }
  const trc = by('translate').filter((e) => e.cache_hit != null);
  const sgu = by('suggest_usage').filter((e) => e.cache_hit != null);
  const pct = (a) => {
    const hit = a.reduce((x, e) => x + (e.cache_hit || 0), 0);
    const all = a.reduce((x, e) => x + (e.cache_hit || 0) + (e.cache_miss || 0), 0);
    return all ? `${Math.round((100 * hit) / all)}% (${hit}/${all} token)` : '—';
  };
  line(`Cache DeepSeek (token đầu vào trúng cache): dịch ${pct(trc)} | gợi ý ${pct(sgu)}`);
  const mf = by('mic_final');
  const md = by('mic_dropped');
  line(`Micro của bạn: ${mf.length} câu ghi nhận | bỏ ${md.length} (tiếng vọng/nhiễu)${md.length ? ': ' + md.slice(0, 3).map((e) => `"${(e.text || '').slice(0, 40)}"(${e.echo})`).join(', ') : ''}`);
  const du = by('deepgram_usage').concat(by('deepgram_closed'));
  if (du.length || by('deepgram_open').length) {
    const sec = Math.max(0, ...by('deepgram_usage').map((e) => e.audio_s || 0));
    const eotFinals = finals.filter((e) => e.engine === 'deepgram');
    line(`Deepgram: mở ${by('deepgram_open').length} lần | lỗi ${by('deepgram_error').length} | âm thanh gửi ≈ ${(sec / 60).toFixed(1)} phút | lượt chốt bởi Flux: ${eotFinals.length}`);
  }
}

// Ghép từng đoạn để đọc chất lượng
if (details) {
  h('Chi tiết từng đoạn');
  for (const fnl of finals) {
    const t = tr.find((e) => e.id === fnl.id);
    line(`\n#${fnl.id} [${fnl.dur}s, whisper ${fnl.proc_ms}ms, ${fnl.reason}, rms ${fnl.rms_voiced}]`);
    line(`  EN: ${fnl.text}`);
    line(`  VI: ${t ? t.vi : '(không có bản dịch)'}${t ? ` (${t.ms}ms)` : ''}`);
  }
  for (const s of sg) {
    line(`\nGợi ý id=${s.id} (${s.provider}, đầu ${s.first_ms}ms / đủ ${s.total_ms}ms):`);
    const t = turns.find((x) => x.text && s.id != null);
    s.replies.forEach((r, i) => line(`  ${i + 1}. ${r.en}\n     ${r.vi}`));
  }
  for (const t of turns) line(`\nLượt ${t.mode}: ${t.text}`);
}
