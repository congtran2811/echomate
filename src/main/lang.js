// Nhận biết đoạn KHÔNG phải tiếng Anh (video tiếng Việt, nhạc có lời, tiếng Trung...) để không tốn tiền dịch/gợi ý.
// Whisper bị ép language=en nhưng vẫn có thể trả chữ Việt khi âm thanh là tiếng Việt, nên kiểm tra ở chữ đầu ra.
const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;

function isNonEnglish(text) {
  const t = (text || '').trim();
  if (!t) return false;
  // Từ 2 ký tự có dấu tiếng Việt trở lên: chắc chắn không phải câu tiếng Anh thường ("café" chỉ có 1).
  if ((t.match(VI_MARKS) || []).length >= 2) return true;
  // Chữ cái ngoài ASCII chiếm nhiều (Hán, Nhật, Hàn, Cyrillic...). Dấu câu cong ’ “ ” không phải chữ cái nên không tính.
  const letters = [...t].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 6) return false;
  const nonAscii = letters.filter((c) => c.charCodeAt(0) > 127).length;
  return nonAscii / letters.length > 0.25;
}

// Whisper hay "nghe ra" vài cụm quen thuộc từ tiếng ồn rất nhỏ ("Thank you.", "you", "Thanks for watching"). Log thật: 3 đoạn như
// vậy đều có âm lượng 0,011–0,015 (giọng thật trung bình 0,058, thấp nhất 0,02), và cả 10 đoạn "có tiếng nhưng không ra chữ".
// Chỉ loại khi VỪA là cụm ảo giác VỪA rất nhỏ, để không mất câu "Thank you." thật nói bình thường.
const PHANTOM_RE = /^(thank you( very much| so much)?|thanks( for watching)?|thank you for watching|you|bye( bye)?|please subscribe|subscribe)\W*$/i;
const QUIET_RMS = 0.03;

function isPhantom(text, rmsVoiced) {
  const t = (text || '').trim();
  return t.length > 0 && PHANTOM_RE.test(t) && Number.isFinite(rmsVoiced) && rmsVoiced < QUIET_RMS;
}

// Lỗi nhận dạng LẶP LẠI đã thấy trong log thật (Nemotron nghe sai cụm quen thuộc của gia sư). Chỉ sửa cụm gần như không bao giờ
// là câu đúng: "say at once" (thật ra là "say it once", gia sư nói rất nhiều lần).
const STT_FIXES = [
  [/\b(say|said|saying) (?:at|a) once\b/gi, '$1 it once'],
];

function fixStt(text) {
  let t = text || '';
  for (const [re, to] of STT_FIXES) t = t.replace(re, to);
  return t;
}

// Tên riêng trong danh sách thuật ngữ mà Nemotron nghe gần đúng ("Kong" -> "Con"/"Cong"): so khớp theo âm đơn giản hoá
// (c->k, bỏ g sau n, bỏ chữ lặp). Chỉ áp dụng cho thuật ngữ một từ, viết hoa; từ thật trùng âm ("con") nằm trong GLOSSARY_SKIP.
const GLOSSARY_SKIP = new Set(['can', 'cone', 'corn', 'cow', 'coin']);
const sound = (w) => w.toLowerCase().replace(/c/g, 'k').replace(/ng\b/g, 'n').replace(/(.)\1+/g, '$1');

function fixGlossary(text, glossary) {
  const terms = (glossary || '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Z][a-z]{2,}$/.test(x));
  let t = text || '';
  for (const term of terms) {
    const key = sound(term);
    t = t.replace(/\b[A-Za-z]{3,}\b/g, (w) =>
      w !== term && !GLOSSARY_SKIP.has(w.toLowerCase()) && /^[A-Z]/.test(w) && w.length <= term.length + 1 && sound(w) === key ? term : w
    );
    // Viết thường ("Perfect con no fixes"): chỉ sửa khi đứng ngay sau lời khen/chào quen thuộc, vì khi đó chắc là gọi tên.
    t = t.replace(/\b(perfect|right|great|good|nice|yes|okay|ok|hey|thanks|exactly|correct|well done)(,?\s+)([a-z]{3,})\b/gi, (m, cue, sep, w) =>
      w !== term && !GLOSSARY_SKIP.has(w.toLowerCase()) && w.length <= term.length + 1 && sound(w) === key ? `${cue}${sep}${term}` : m
    );
  }
  return t;
}

// Đoạn vừa chốt kết thúc bằng một câu hỏi hoàn chỉnh (wh-/trợ động từ đứng đầu, đủ dài): có thể bắt đầu gợi ý ngay,
// không cần chờ thêm để chắc là hết lượt. Chữ nhận dạng thường không có dấu "?", nên xét theo từ mở đầu của câu cuối.
const Q_START = /^(what|what's|who|whom|whose|where|when|why|how|which|do|does|did|can|could|would|will|should|is|are|was|were|have|has|if you could)\b/i;
function endsWithQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const last = t
    .split(/(?<=[.?!])\s+|\bquestion (?:\w+)\s+/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .pop() || '';
  if (/\?\s*$/.test(t) && last.split(/\s+/).length >= 3) return true;
  const notMeaning = (x) => !/^(what|how|where|when|why|who) (i|we|you|they|he|she) (mean|meant|said|say|think|do is)\b/i.test(x);
  const words = (x) => x.split(/\s+/).filter(Boolean).length;
  if (words(last) >= 4 && Q_START.test(last) && notMeaning(last)) return true;
  // Câu hỏi nằm sau lời chào/đệm trong cùng câu: "Hi there, what can I get for you today", "Sure, just the burger or do you want the combo".
  const clause = last.split(/,\s*|\s+(?:and|or|so|but)\s+/i).map((x) => x.trim()).filter(Boolean).pop() || '';
  if (clause !== last && words(clause) >= 4 && Q_START.test(clause) && notMeaning(clause)) return true;
  // Hỏi chọn ("Small, medium, or large"; "for here or to go"; "Any sauces") thường gặp khi gọi món/dịch vụ.
  if (/^(?:\w+,\s+){1,3}(?:or|and)\s+\w+$/i.test(last) && words(last) <= 6) return true;
  if (/\b(?:for here or to go|here or to go|paper or plastic|cash or card|card or cash)\s*$/i.test(last)) return true;
  if (/^any (?:\w+\s*){1,3}$/i.test(last)) return true;
  return false;
}

module.exports = { isNonEnglish, isPhantom, fixStt, fixGlossary, endsWithQuestion, QUIET_RMS };
