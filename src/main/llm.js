// Dịch EN→VI và gợi ý trả lời qua DeepSeek hoặc Ollama (cả hai đều tương thích OpenAI).
// Hai việc chạy song song: dịch (ngắn, nhanh) và gợi ý (streaming, hiện từng câu).
//
// Prompt viết bằng tiếng Anh + ví dụ mẫu dạng lượt hội thoại: model Qwen (qua Ollama) hay "trôi" sang
// chữ Hán khi system prompt là tiếng Việt. Thêm bộ lọc FOREIGN làm lưới an toàn.
const STYLES = {
  concise: 'short and natural',
  polite: 'polite and professional',
  casual: 'friendly and casual',
};

// Độ dài mỗi gợi ý: số từ tối đa và giới hạn token cho cả lượt trả lời (3 gợi ý EN + VI).
const LENGTHS = {
  short: { words: 14, tokens: 300, hint: 'one short sentence' },
  medium: { words: 25, tokens: 450, hint: 'one or two sentences' },
  long: { words: 45, tokens: 700, hint: 'two or three sentences, with a bit of explanation or detail' },
};
const lengthOf = (s) => LENGTHS[s.replyLength] || LENGTHS.medium;

const FILLER =/^(yeah|yes|yep|no|ok|okay|right|sure|uh|um|hmm|mm|well|so|and|thanks|thank you|hi|hello|hey|bye)\W*$/i;
const MAX_REPLIES = 3;

// Ký tự không thuộc tiếng Việt/Anh: Hán, Nhật, Hàn, Cyrillic, dạng full-width.
const FOREIGN = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ＀-￯]/;
const VI_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const cutForeign = (t) => {
  const i = t.search(FOREIGN);
  return (i >= 0 ? t.slice(0, i) : t).trim();
};

function wantReply(text) {
  const t = text.trim();
  return t.split(/\s+/).length >= 3 && !FILLER.test(t);
}

// Tên model DeepSeek đổi theo thời gian (tài liệu chính thức hiện ghi "deepseek-flash"; "deepseek-v4-flash" và
// "deepseek-chat" là tên cũ). Thử lần lượt và nhớ tên nào chạy được.
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-chat'];
let workingDeepseekModel = null;

// Mỗi tác vụ có thể dùng nhà cung cấp riêng: dịch (mỗi đoạn, gọi dày) chạy local, gợi ý (ít gọi hơn) chạy DeepSeek.
function pick(s, task) {
  if (task === 'suggest' && s.suggestProvider && s.suggestProvider !== 'same') {
    return { ...s, provider: s.suggestProvider };
  }
  return s;
}

function endpoint(s) {
  if (s.provider === 'ollama') {
    return { url: 'http://localhost:11434/v1/chat/completions', model: s.ollamaModel, headers: {} };
  }
  if (!s.deepseekKey) throw new Error('Chưa nhập API key DeepSeek (Cài đặt)');
  return {
    url: 'https://api.deepseek.com/chat/completions',
    model: workingDeepseekModel || s.deepseekModel,
    headers: { Authorization: `Bearer ${s.deepseekKey}` },
  };
}

const ctxBlock = (history, n) =>
  history.slice(-n).map((h) => `- ${h}`).join('\n') || '(none)';

// ---------- Dịch ----------
// Luật dịch riêng cho buổi luyện với gia sư (giữ câu mẫu tiếng Anh, giải nghĩa từ lẻ...). Chỉ bật khi ô "bối cảnh" nói rõ là buổi luyện:
// log thật cho thấy áp luật này vào hội thoại thường làm hỏng bản dịch ("So" -> "So (từ nối...)").
const isTutor = (s) => (s && s.mode ? s.mode === 'tutor' : /tutor|gia sư|luyện|practice|lesson|teacher|giáo viên|học tiếng/i.test((s && s.context) || ''));

function translateSystem(s) {
  return [
    'You are an English-to-Vietnamese interpreter for a live conversation.',
    'Translate ONLY the sentence after "Translate:" into natural Vietnamese; fix obvious speech-recognition errors.',
    'The "Earlier sentences" are background for resolving meaning (pronouns, topic) ONLY. NEVER translate or repeat them.',
    'Output ONLY the Vietnamese translation, written entirely in Vietnamese (Latin script with diacritics), on a single line.',
    'NEVER output Chinese, Japanese, Korean or Russian characters. No explanations and no labels; do not wrap the whole translation in quotation marks.',
    ...(isTutor(s)
      ? [
      'If the speaker is a language tutor, English words, phrases or sentences that they quote or name as examples, corrections or things to practice (for example: say "I would", after needs an object, "I\'d change" came out clearly) must stay in English, inside quotation marks, exactly as written. Translate only the explanation around them. A word being discussed is a WORD, not part of the sentence meaning: "because" in "the word because joins the sentences" is the word itself.',
      'If the text is only one or two words and the earlier sentences show the tutor asking to practice a word or sound (say it slowly, in pieces, start with...), do not translate it as a sentence: output the word in quotation marks followed by a short Vietnamese gloss in parentheses, e.g. "I\'d" (viết tắt của I would).',
      'When the tutor asks a new question (for example "Question three, what do you want to do this weekend?"), translate the whole question into natural Vietnamese. Do NOT leave it in English and do not put it in quotation marks. Only text the learner is told to repeat (after "say it once", "say that") stays in English inside quotation marks.',
      'When the tutor repeats the learner\'s mistake to point it out (a repeated word, a wrong word, a missing word), keep the mistake exactly as spoken inside quotation marks and say what is wrong. NEVER silently correct it.',
        ]
      : [
          // Log thật (chế độ trò chuyện, người kia sửa câu cho bạn): "say I work as a developer with the A in front" bị dịch thành câu nói của họ.
          'When the speaker quotes or names English words, phrases or sentences that are being discussed (for example corrections like: you said "save" but meant "say"; say "I work as a developer"; "it took me a while to track down" was perfect), keep those quoted parts in English inside quotation marks exactly as spoken, and translate only the explanation around them.',
          'If the text is only a short fragment or filler (one or two words such as "So", "But", "Disconnect", "I\'m"), translate it plainly as a natural spoken fragment (for example "Vậy thì…", "Nhưng…"). Never add explanations, glosses or notes in parentheses, and never put it in quotation marks.',
        ]),
    // Từ log thật: nhận dạng thiếu dấu câu và nhầm từ đồng âm làm bản dịch đảo nghĩa ("is right now" -> "chưa đúng").
    'The text comes from speech recognition: punctuation is often missing and homophones are often confused (to/two/too, there/their, for/four, right/write). Pick the word that fits the lesson (for example "the best advice I got was two" is really "was to"), and never invent a negative or a correction that the text does not state: if the tutor praises something, the translation must also praise it. If part of the text is unclear, translate it literally and cautiously.',
    s.context ? `Conversation context: ${s.context}` : '',
    s.glossary ? `Names and terms to keep exactly as written (do not translate them): ${s.glossary}` : '',
  ].filter(Boolean).join('\n');
}

const translateUser = (history, text) =>
  `Translate: ${text}\n\nEarlier sentences (background only, do not translate):\n${ctxBlock(history, 4)}`;

const TRANSLATE_SHOTS = [
  { role: 'user', content: translateUser(['We noticed a few bugs in the last release.'], 'When can your team fix them?') },
  { role: 'assistant', content: 'Khi nào đội của bạn có thể sửa chúng?' },
  { role: 'user', content: translateUser([], 'We changed how reports are generated.') },
  { role: 'assistant', content: 'Chúng tôi đã thay đổi cách tạo báo cáo.' },
  { role: 'user', content: translateUser(['So let me explain our situation.'], 'Our budget is tight, so we need an annual discount.') },
  { role: 'assistant', content: 'Ngân sách của chúng tôi khá eo hẹp nên chúng tôi cần giảm giá theo năm.' },
  // Người kia sửa câu cho bạn (cả khi trò chuyện thường): phần được trích giữ tiếng Anh trong ngoặc kép.
  { role: 'user', content: translateUser(['Nice, a designer.'], 'Small fix, say I work as a designer with the A in front.') },
  { role: 'assistant', content: 'Sửa nhỏ: hãy nói "I work as a designer", có chữ "a" ở phía trước.' },
];

const TUTOR_SHOTS = [
  // Gia sư: từ được nhắc tới giữ tiếng Anh trong ngoặc kép, chỉ dịch phần giải thích.
  { role: 'user', content: translateUser(['Nice work.'], 'And because joins the two sentences smoothly.') },
  { role: 'assistant', content: 'Và từ "because" nối hai câu rất mượt.' },
  { role: 'user', content: translateUser(['One small polish.'], "Say it once, that's the main thing I'd change.") },
  { role: 'assistant', content: 'Nói lại một lần: "that\'s the main thing I\'d change".' },
  { role: 'user', content: translateUser(['Nice and clear.'], 'Question three. What do you want to do this weekend?') },
  { role: 'assistant', content: 'Câu hỏi số ba: Cuối tuần này bạn muốn làm gì?' },
  { role: 'user', content: translateUser(['Very close.'], 'You said it it twice at the start.') },
  { role: 'assistant', content: 'Bạn đã nói "it it" hai lần ở đầu câu.' },
  { role: 'user', content: translateUser(['Let\'s slow it down into two parts. First say I\'d like.'], "I'd") },
  { role: 'assistant', content: '"I\'d" (viết tắt của I would)' },
];

// Giữ kết nối HTTPS tới DeepSeek mở (mặc định Node đóng sau ~4 s rảnh nên mỗi lần sau khoảng nghỉ lại phải bắt tay lại).
// Đo thực tế: sau nghỉ 8 s, 207 ms -> 114 ms. Không có undici thì dùng fetch mặc định.
let dispatcher = null;
try {
  const { Agent } = require('undici');
  dispatcher = new Agent({ keepAliveTimeout: 60000, keepAliveMaxTimeout: 600000, connections: 6 });
} catch {
  dispatcher = null;
}

// Mở sẵn kết nối tới DeepSeek (gọi khi bắt đầu nghe) để câu đầu tiên không phải bắt tay.
function prewarmNet(s) {
  if (!dispatcher || (s.provider !== 'deepseek' && s.suggestProvider !== 'deepseek')) return;
  fetch('https://api.deepseek.com/', { method: 'HEAD', dispatcher, signal: AbortSignal.timeout(5000) }).catch(() => {});
}

async function request(s, ep, messages, extra, signal) {
  const isDs = s.provider === 'deepseek';
  const models = isDs ? [...new Set([ep.model, ...DEEPSEEK_MODELS])] : [ep.model];
  // Tắt chế độ "thinking" của DeepSeek để trả lời nhanh; nếu API không nhận tham số này thì bỏ đi và gọi lại.
  let ex = isDs ? { thinking: { type: 'disabled' }, ...extra } : extra;
  let status = 0;
  let body = '';
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ep.headers },
        body: JSON.stringify({ model, messages, ...ex }),
        signal,
        ...(isDs && dispatcher ? { dispatcher } : {}),
      });
      if (res.ok) {
        if (isDs) workingDeepseekModel = model;
        return res;
      }
      status = res.status;
      body = (await res.text()).slice(0, 300);
      if (isDs && status === 400 && ex.thinking && /thinking/i.test(body)) {
        const { thinking, ...rest } = ex;
        ex = rest;
        continue;
      }
      break;
    }
    // Chỉ thử tên model khác khi lỗi là do tên model; lỗi khác (key sai, hết tiền, quá tải) thì dừng ngay.
    const modelProblem = isDs && [400, 404, 422].includes(status) && /model/i.test(body);
    if (!modelProblem) break;
    console.warn(`[llm] DeepSeek không nhận model "${model}", thử tên khác`);
  }
  throw new Error(`${s.provider} HTTP ${status}: ${body.slice(0, 200)}`);
}

// Thời gian chờ tối đa: khi GPU nghẽn, một yêu cầu từng treo tới 2 phút và hiện bản dịch đã quá muộn.
const TRANSLATE_TIMEOUT_MS = { ollama: 8000, deepseek: 12000 };
const SUGGEST_TIMEOUT_MS = { ollama: 25000, deepseek: 20000 };

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// Đổi lỗi hết giờ của fetch thành lỗi dễ hiểu (có cờ .timeout để nơi gọi nhận biết).
function friendly(e, ms) {
  if (e && e.name === 'TimeoutError') {
    return Object.assign(new Error(`Quá thời gian chờ (${Math.round(ms / 1000)}s)`), { timeout: true });
  }
  return e;
}

async function chatOnce(s, ep, messages, signal) {
  const res = await request(
    s,
    ep,
    messages,
    { temperature: 0, max_tokens: 200, stream: false, stop: ['\nuser', '\nUser', '\nassistant'] },
    signal
  );
  const data = await res.json();
  return { vi: cleanTranslation(data.choices[0].message.content), usage: data.usage || null };
}

// Chỉ bỏ dấu ngoặc kép khi CẢ chuỗi nằm trong một cặp ngoặc và bên trong không còn ngoặc nào khác. Trước đây cắt mọi
// dấu ngoặc ở đầu/cuối nên bản dịch như `"I'd" là viết tắt của "I would".` thành `I'd" là viết tắt của "I would`.
function unwrapQuotes(s) {
  const m = s.match(/^["“]([\s\S]*)["”]$/);
  return m && !/["“”]/.test(m[1]) ? m[1].trim() : s;
}

// Model có thể trả mỗi câu một dòng: ghép TẤT CẢ các dòng (trước đây chỉ lấy dòng đầu nên đoạn nhiều câu bị cụt:
// log thật cho thấy đoạn 2 câu chỉ dịch 1 câu). Dừng ở dòng giả lập lượt hội thoại ("user", "assistant:") do model "trôi".
function cleanTranslation(content) {
  const lines = [];
  for (const l of String(content || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (/^(user|assistant|system|human)\b/i.test(l)) break;
    lines.push(l);
  }
  return unwrapQuotes(lines.join(' ').trim());
}

async function translate(s, history, text) {
  const ms = TRANSLATE_TIMEOUT_MS[s.provider] || 10000;
  try {
    return await translateInner(s, history, text, AbortSignal.timeout(ms));
  } catch (e) {
    throw friendly(e, ms);
  }
}

async function translateInner(s, history, text, signal) {
  const ep = endpoint(s);
  const base = [
    { role: 'system', content: translateSystem(s) },
    ...TRANSLATE_SHOTS,
    ...(isTutor(s) ? TUTOR_SHOTS : []),
    { role: 'user', content: translateUser(history, text) },
  ];
  const out = await chatOnce(s, ep, base, signal);
  if (!FOREIGN.test(out.vi)) return out;

  // Model trôi sang chữ Hán/Nga…: báo lỗi cho model rồi dịch lại; nếu vẫn lỗi thì cắt bỏ phần lỗi.
  console.warn('[llm] translate: bản dịch lẫn chữ lạ, dịch lại');
  const retry = await chatOnce(s, ep, [
    ...base,
    { role: 'assistant', content: out.vi },
    {
      role: 'user',
      content:
        'Your answer contained non-Vietnamese characters. Translate the same sentence again, using ONLY Vietnamese words (Latin letters with diacritics). Output only the translation.',
    },
  ], signal);
  const tokens = (out.usage?.total_tokens || 0) + (retry.usage?.total_tokens || 0);
  return { vi: FOREIGN.test(retry.vi) ? cutForeign(retry.vi) : retry.vi, usage: { total_tokens: tokens } };
}

// ---------- Gợi ý ----------
// Mức tiếng Anh của câu gợi ý. "simple": người đang học đọc to được ngay; "natural": như người bản xứ.
const LEVEL_RULES = {
  simple:
    'English level: SIMPLE words but NATURAL spoken English, the way a native speaker talks with a friend or colleague (about CEFR B1 vocabulary). Short sentences (no more than 14 words each), common everyday words, and ALWAYS use contractions (I\'m, I\'d, don\'t, it\'s, that\'s). Use the natural everyday collocation, not a word-by-word construction: "learn to cook" (not "learn cooking"), "it takes me a while to fall asleep", "I usually go to bed late", "Give me a second" (not "I will tell you in a second"), "How about you?", "Good question.". Fillers (Honestly, Wait, Hmm, Actually, Well) are allowed in AT MOST ONE option and only when it truly fits; never start two options with the same word; most options should begin directly with their content. Never sound like a textbook (avoid "I do not", "Can I say a small thing?", "this one is easy for me"). No rare idioms or hard-to-pronounce words. The user will read these aloud, so prefer two short sentences over one long sentence.',
  natural:
    'English level: NATURAL, like an educated native speaker in casual conversation: contractions, natural collocations and phrasal verbs where a native would use them, and an occasional spoken filler in at most one option ("Well,", "I mean,"). Never start two options with the same word. Never textbook English.',
};
const levelOf = (s) => (LEVEL_RULES[s.replyLevel] !== undefined ? s.replyLevel : 'simple');

function suggestSystem(s) {
  return [
    'You help a Vietnamese speaker reply in a live English conversation.',
    `Given what the other person just said, output exactly ${MAX_REPLIES + 1} reply options for the Vietnamese speaker to say next, each with a different intent. Typical intents: agree; ask a clarifying question; politely decline or raise a concern; propose an alternative or add a detail; ask for more time or information. Pick the intents that fit the context best.`,
    'Each option is what the Vietnamese speaker says in response. NEVER repeat, restate or paraphrase what the other person said.',
    'The FIRST option must be the most common direct answer to what was just asked or requested (do not ask a question back, do not be vague like "I understand"). The remaining options then vary in intent.',
    'If the latest sentence is cut off, use the previous turns to understand it, then answer.',
    `Style: ${STYLES[s.style] || STYLES.concise}; each option is ${lengthOf(s).hint}, at most ${lengthOf(s).words} words; sound like a real person.`,
    LEVEL_RULES[levelOf(s)],
    s.diarize || s.micEnabled
      ? 'The conversation may include several people. In the previous turns, lines starting with "Me:" are what the Vietnamese speaker ALREADY said: stay consistent with them and never repeat them. Lines starting with "Speaker X:" are other people. Reply to the latest speaker only.'
      : '',
    'In every Vietnamese translation, address the other person as "bạn" (never "anh/chị", "quý khách" or other formal terms) unless the conversation context says otherwise.',
    'Option 2 should usually be a natural question a real person would ask back in this situation (a clarifying question, or returning the question: "How about you?"), because the user will use these in real conversations with people.',
    'The Vietnamese speaker understands the other person (they can read the Vietnamese translation). NEVER mention their English level, accent or that they are learning English, and NEVER ask the other person to repeat or to speak slower, unless the user info above explicitly asks for that or the other person\'s sentence is clearly cut off or unintelligible.',
    'If the other person asks the Vietnamese speaker to say, repeat or complete a specific sentence (for example "Say it once: ..." or "Start with: ..."), option 1 MUST be exactly that sentence, word for word, with nothing added or changed. Options 2 and 3 may be natural variations of it.',
    'This repeat rule applies ONLY when the request to repeat is the LAST thing they said. If they asked a new question after it (for example "... you could say X. How often do you deploy, by the way?"), answer the new question instead.',
    'Option 1 must ALWAYS be a direct answer to what was asked. If you lack a personal fact, still answer, using [placeholders]. NEVER replace the direct answer with a question back, a request to repeat, or a request for time.',
    s.context ? `Conversation context: ${s.context}` : '',
    s.persona
      ? `About the Vietnamese speaker (the user) and their role in this conversation: ${s.persona}. These are the ONLY facts you know about them.`
      : '',
    s.glossary ? `Names and terms that may come up (use them correctly): ${s.glossary}` : '',
    'Do NOT invent personal facts or commitments for the Vietnamese speaker. This includes: years of experience, employers, jobs, skills or tools used, achievements, results, numbers, prices, salary, dates, deadlines, promises, health, feelings, and even vague made-up claims such as "I helped my team reach its targets" or "my team is busy". Use only facts from the user info above or from the conversation itself.',
    'Whenever an answer needs a personal fact you were NOT given, write a placeholder in square brackets instead, e.g. [number of years], [your achievement], [expected salary], [your current employer], [your field]. In the Vietnamese translation, translate the text inside the brackets into Vietnamese and keep the brackets, e.g. [số năm], [thành tích của bạn], [mức lương mong muốn].',
    `FORMAT: exactly ${MAX_REPLIES + 1} lines, one option per line. Each line is the English reply, then the separator " || ", then its Vietnamese translation (entirely Vietnamese, Latin script with diacritics). The English part must come first and be in English. NEVER output Chinese, Japanese, Korean or Russian characters. No numbering, no bullets, no labels, no explanations, no other lines. See the example conversation.`,
  ].filter(Boolean).join('\n');
}

// Ví dụ mẫu phải có độ dài giống mức người dùng chọn, nếu không model nhỏ sẽ bắt chước ví dụ và cứ trả lời ngắn.
const SHOT_REPLIES = {
  short: [
    'Sure, I can send it by Friday. || Được, tôi có thể gửi trước thứ Sáu.',
    'Which version of the report do you need? || Bạn cần phiên bản báo cáo nào?',
    "I'm afraid Friday is tight for me. || Tôi e là thứ Sáu hơi gấp với tôi.",
    'Let me check my schedule and get back to you. || Để tôi xem lịch rồi báo lại bạn.',
  ],
  medium: [
    "Sure, I can send it over by Friday. I'll make sure it has the latest numbers from this week. || Được, tôi có thể gửi trước thứ Sáu. Tôi sẽ đảm bảo báo cáo có số liệu mới nhất của tuần này.",
    'Which version of the report do you need? I have both the summary and the detailed breakdown ready. || Bạn cần phiên bản báo cáo nào? Tôi có sẵn cả bản tóm tắt lẫn bản chi tiết.',
    "I'm afraid Friday is a bit tight for me. Would Monday morning work instead? || Tôi e là thứ Sáu hơi gấp với tôi. Sáng thứ Hai có được không?",
    'Let me check my schedule and get back to you shortly. || Để tôi xem lịch rồi báo lại bạn sớm.',
  ],
  long: [
    "Sure, I can send it over by Friday afternoon. I'll include the latest numbers from this week, plus a short summary of the main changes so it's quick for you to review. || Được, tôi có thể gửi trước chiều thứ Sáu. Tôi sẽ kèm số liệu mới nhất của tuần này và một bản tóm tắt ngắn các thay đổi chính để bạn xem nhanh.",
    'Which version of the report do you need? I have a one-page summary and a full detailed breakdown, so I can send whichever is more useful for your meeting. || Bạn cần phiên bản báo cáo nào? Tôi có bản tóm tắt một trang và bản chi tiết đầy đủ, nên có thể gửi bản nào hữu ích hơn cho buổi họp của bạn.',
    "I'm afraid Friday is a bit tight for me because of another deadline. Would Monday morning work instead? I can send it first thing. || Tôi e là thứ Sáu hơi gấp với tôi vì còn một hạn chót khác. Sáng thứ Hai có được không? Tôi có thể gửi ngay đầu giờ.",
    "Let me check my schedule and get back to you shortly. If it's urgent, just let me know and I'll see what I can do about a draft. || Để tôi xem lịch rồi báo lại bạn sớm. Nếu gấp, bạn cứ cho tôi biết, tôi sẽ xem có thể làm bản nháp được không.",
  ],
};

// Cùng ví dụ nhưng viết ở mức tiếng Anh đơn giản (câu ngắn, từ thông dụng), dùng khi replyLevel = simple.
const SIMPLE_SHOT_REPLIES = {
  short: [
    'Sure, I can send it by Friday. || Được, tôi có thể gửi trước thứ Sáu.',
    'Which report do you need? || Bạn cần báo cáo nào?',
    'Friday is hard for me. || Thứ Sáu hơi khó với tôi.',
    'Can I send it on Monday? || Tôi gửi vào thứ Hai được không?',
  ],
  medium: [
    'Sure, I can send it by Friday. Is that okay for you? || Được, tôi gửi trước thứ Sáu. Như vậy ổn với bạn không?',
    'Which report do you need? Do you need the short one or the full one? || Bạn cần báo cáo nào? Bản ngắn hay bản đầy đủ?',
    'Friday is a little hard for me. Can I send it on Monday? || Thứ Sáu hơi khó với tôi. Tôi gửi vào thứ Hai được không?',
    'Let me check first. I\'ll let you know soon. || Để tôi kiểm tra trước. Tôi sẽ báo bạn sớm.',
  ],
  long: [
    'Sure, I can send it by Friday. I\'ll do my best to finish on time. Let me know if you need anything else. || Được, tôi có thể gửi trước thứ Sáu. Tôi sẽ cố gắng xong đúng hạn. Nếu bạn cần gì thêm, hãy cho tôi biết.',
    'Which report do you need? I can send the short one or the full one. Which one is better for you? || Bạn cần báo cáo nào? Tôi có thể gửi bản ngắn hoặc bản đầy đủ. Bản nào tốt hơn cho bạn?',
    'Friday is a little hard for me. Can I send it on Monday instead? That will give me more time. || Thứ Sáu hơi khó với tôi. Tôi gửi vào thứ Hai thay được không? Như vậy tôi có thêm thời gian.',
    'Let me check first. I\'ll let you know soon. Is that okay? || Để tôi kiểm tra trước. Tôi sẽ báo bạn sớm. Như vậy ổn không?',
  ],
};

// Ví dụ thứ hai: câu hỏi về kinh nghiệm/thành tích cá nhân mà người dùng chưa khai -> dùng chỗ trống, không bịa.
const PERSONAL_SHOT = [
  {
    role: 'user',
    content:
      'Previous turns of the other person:\n(none)\n\nThe other person just said: "How many years of experience do you have, and what was your biggest achievement in your last job?"',
  },
  {
    role: 'assistant',
    content: [
      'I have [number of years] of experience in [your field], and my biggest achievement was [your achievement]. || Tôi có [số năm] kinh nghiệm trong [lĩnh vực của bạn], và thành tích lớn nhất của tôi là [thành tích của bạn].',
      'Do you mean experience in this exact role, or in the industry in general? || Ý bạn là kinh nghiệm đúng vị trí này hay trong ngành nói chung?',
      'Let me think about which achievement fits this role best. || Để tôi nghĩ xem thành tích nào hợp với vị trí này nhất.',
      'Could I start with my most recent job and then add more detail? || Tôi bắt đầu từ công việc gần nhất rồi bổ sung thêm chi tiết được không?',
    ].join('\n'),
  },
];

function suggestShots(s) {
  return [
    {
      role: 'user',
      content: 'Previous turns of the other person:\n(none)\n\nThe other person just said: "Can you send me the report by Friday?"',
    },
    {
      role: 'assistant',
      content: ((levelOf(s) === 'simple' ? SIMPLE_SHOT_REPLIES : SHOT_REPLIES)[s.replyLength] || SHOT_REPLIES.medium).join('\n'),
    },
    ...PERSONAL_SHOT,
  ];
}

// ---- Kiểm tra "bịa" bằng code (lớp bảo vệ thứ hai ngoài prompt) ----
// Gắn cảnh báo cho gợi ý chứa con số chưa từng xuất hiện trong hội thoại/thông tin của bạn, hoặc nói về kinh nghiệm,
// thành tích mà bạn chưa khai. Chỉ là heuristic: cảnh báo để người dùng kiểm tra, không tự xoá gợi ý.
const NUM_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, half: 0.5,
};
const NUM_WORD_RE = new RegExp(`\\b(${Object.keys(NUM_WORDS).join('|')})\\b`, 'gi');
const CLAIM_RE = new RegExp(
  [
    'years? of experience',
    'my (?:biggest|greatest|proudest|main|top) (?:achievement|accomplishment)',
    'my (?:last|previous|current|former) (?:job|company|employer|role|position)',
    'at my (?:last|previous|current|former) (?:job|company|role)',
    'I (?:have|had) (?:worked|been|led|managed|built|achieved|increased|reduced|helped|handled|delivered|launched)',
    'I (?:worked|led|managed|built|achieved|increased|reduced|helped|handled|delivered|launched)',
  ].join('|'),
  'gi'
);

// Nhắc tới một cuộc trao đổi/thoả thuận trước đó mà hội thoại không hề có ("as we discussed earlier"): luôn cảnh báo.
const PRIOR_RE = /\b(?:we|you and I) (?:discussed|agreed|talked about|spoke about|covered)\b|\bas (?:I|we) (?:mentioned|said|discussed|agreed)\b|\bour (?:earlier|previous|last) (?:conversation|discussion|call|meeting)\b/i;

function numbersIn(text) {
  const out = new Set();
  for (const m of text.match(/\d[\d.,]*/g) || []) {
    const n = parseFloat(m.replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(n);
  }
  for (const m of text.match(NUM_WORD_RE) || []) out.add(NUM_WORDS[m.toLowerCase()]);
  return out;
}

// allowedText: mọi thứ bạn đã cung cấp hoặc đã được nói trong hội thoại (vai trò, bối cảnh, thuật ngữ, lượt trước, câu vừa rồi).
function unverifiedClaims(en, allowedText, hasPersona) {
  const warn = [];
  const body = en.replace(/\[[^\]]*\]/g, ' '); // chỗ trống [ ... ] là hợp lệ, không kiểm tra bên trong
  const allowed = numbersIn(allowedText);
  const extra = [...numbersIn(body)].filter((n) => !allowed.has(n));
  if (extra.length) warn.push(`con số tự thêm (${extra.join(', ')})`);
  if (PRIOR_RE.test(body) && !PRIOR_RE.test(allowedText)) warn.push('nhắc tới cuộc trao đổi trước đó không có trong hội thoại');
  if (!hasPersona) {
    for (const m of body.matchAll(CLAIM_RE)) {
      // Nếu ngay sau cụm nói về kinh nghiệm/thành tích đã có chỗ trống [ ... ] trong en gốc thì coi là hợp lệ.
      const end = en.indexOf(m[0]) + m[0].length;
      if (!en.slice(end, end + 45).includes('[')) {
        warn.push('kinh nghiệm/thành tích bạn chưa khai');
        break;
      }
    }
  }
  return warn;
}

function parseReply(line) {
  const clean = line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim();
  if (!clean) return null;
  const [en, ...rest] = clean.split(/\s*\|\|\s*/);
  // Một số model thêm nhãn như "English reply:" / "Vietnamese translation:" — bỏ đi.
  const strip = (t, label) =>
    unwrapQuotes(t.replace(label, '').trim());
  const e = strip(en, /^\s*(?:english(?: reply)?|reply)\s*:\s*/i);
  if (!e || FOREIGN.test(e)) return null; // câu tiếng Anh lẫn chữ lạ: bỏ cả gợi ý
  if (VI_DIACRITICS.test(e)) return null; // phần "tiếng Anh" lại là tiếng Việt (model sai định dạng)
  // Chép nguyên khuôn mẫu trong prompt ("English reply || Vietnamese translation"): bỏ.
  if (/^(?:english(?: reply)?|reply)$/i.test(e)) return null;
  const vi = cutForeign(strip(rest.join(' '), /^\s*(?:vietnamese(?: translation)?|tiếng việt)\s*:\s*/i));
  return { en: e, vi };
}

// Người kia yêu cầu bạn nói/lặp lại một câu cụ thể ("Say it once, ...", "Repeat after me", "Start with ..."): khi đó
// gợi ý GIỐNG câu của họ mới là câu trả lời đúng, nên không được lọc "lặp lại câu hỏi".
const REPEAT_REQ_RE = /\b(say (it|this|that|the|one|your|each)|repeat|try saying|read (it|this|that)|start with|once more|one more time|say once|say it again)\b/i;
const isRepeatRequest = (text) => REPEAT_REQ_RE.test(text || '');

// Gợi ý trùng phần lớn chữ với câu người kia vừa nói = chỉ lặp lại câu hỏi, bỏ đi.
const words = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function isEcho(reply, source) {
  const r = words(reply);
  if (r.length < 3) return false;
  const src = new Set(words(source));
  return r.filter((w) => src.has(w)).length / r.length >= 0.8;
}

// Gọi onReply({en, vi}) ngay khi mỗi dòng gợi ý hoàn chỉnh trong luồng trả về.
async function suggest(settings, history, text, onReply, signal, echoSource = text) {
  const ms = SUGGEST_TIMEOUT_MS[pick(settings, 'suggest').provider] || 20000;
  try {
    return await suggestInner(settings, history, text, onReply, withTimeout(signal, ms), echoSource);
  } catch (e) {
    throw friendly(e, ms);
  }
}

async function suggestInner(settings, history, text, onReply, signal, echoSource) {
  const s = pick(settings, 'suggest');
  const ep = endpoint(s);
  const messages = [
    { role: 'system', content: suggestSystem(s) },
    ...suggestShots(s),
    {
      role: 'user',
      content: `${s.diarize || s.micEnabled ? 'Previous turns of the conversation' : 'Previous turns of the other person'}:\n${ctxBlock(history, 6)}\n\n${s.whoLabel ? `${s.whoLabel} just said` : 'The other person just said'} (may be several sentences; if it contains a question or request, answer that): "${text}"`,
    },
  ];
  const res = await request(
    s,
    ep,
    messages,
    { temperature: 0.6, max_tokens: lengthOf(s).tokens, stream: true, stream_options: { include_usage: true } },
    signal
  );

  let count = 0;
  let pending = '';
  let usage = null;
  let generated = 0; // số ký tự model đã sinh ra (kể cả dòng bị lọc)
  const allowedText = [s.persona, s.context, s.glossary, ...history, text].filter(Boolean).join(' ');
  const hasPersona = !!(s.persona && s.persona.trim());
  const echoOk = isRepeatRequest(text); // bị yêu cầu nói lại một câu: không lọc gợi ý trùng câu của họ
  // Luồng bị ngắt sớm nên API không báo số token; ước tính theo số ký tự (~3,8 ký tự/token cho prompt tiếng Anh,
  // ~3,2 ký tự/token cho phần trả lời gồm tiếng Anh + tiếng Việt).
  const estimate = () => ({
    provider: s.provider,
    prompt: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.8),
    completion: Math.ceil(generated / 3.2),
  });
  const emit = (line) => {
    if (count >= MAX_REPLIES) return;
    const r = parseReply(line);
    if (r && (echoOk || !isEcho(r.en, echoSource))) {
      count += 1;
      const warn = unverifiedClaims(r.en, allowedText, hasPersona);
      onReply(warn.length ? { ...r, warn } : r);
    }
  };
  const flush = (last) => {
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      emit(pending.slice(0, i));
      pending = pending.slice(i + 1);
    }
    if (last && pending.trim()) {
      emit(pending);
      pending = '';
    }
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let sse = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += dec.decode(value, { stream: true });
    let j;
    while ((j = sse.indexOf('\n')) >= 0) {
      const l = sse.slice(0, j).trim();
      sse = sse.slice(j + 1);
      if (!l.startsWith('data:')) continue;
      const d = l.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const o = JSON.parse(d);
        const c = o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content;
        if (c) {
          pending += c;
          generated += c.length;
          flush(false);
        }
        if (o.usage) usage = o.usage;
      } catch {
        /* bỏ qua dòng SSE lỗi */
      }
    }
    // Đủ số gợi ý: ngắt luồng để model ngừng sinh (yêu cầu dư 1 dòng phòng khi có dòng lỗi bị lọc).
    if (count >= MAX_REPLIES) {
      // Đủ gợi ý: trả kết quả ngay, nhưng vẫn đọc nốt luồng ở nền để lấy số token thật (kèm số token trúng cache
      // của DeepSeek). Phần model sinh thêm chỉ là dòng dư thứ tư, vài chục token.
      const usageP = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sse += dec.decode(value, { stream: true });
            let k;
            while ((k = sse.indexOf('\n')) >= 0) {
              const l = sse.slice(0, k).trim();
              sse = sse.slice(k + 1);
              if (!l.startsWith('data:')) continue;
              const d = l.slice(5).trim();
              if (d === '[DONE]') continue;
              try {
                const o = JSON.parse(d);
                if (o.usage) usage = o.usage;
              } catch {
                /* bỏ qua */
              }
            }
          }
        } catch {
          /* bị huỷ khi có gợi ý mới: không có số liệu */
        }
        return usage;
      })();
      return { count, usage, usageP, est: estimate() };
    }
  }
  flush(true);
  return { count, usage, est: estimate() };
}

// Nạp sẵn model Ollama và giữ trong VRAM 30 phút để câu đầu tiên không bị chậm vì nạp model.
let lastWarm = 0;
function warmup(s) {
  // Cần model local khi: dịch/gợi ý chạy Ollama, hoặc bật bản dịch nháp local (dịch chính bằng DeepSeek).
  const needsLocal =
    s.provider === 'ollama' || s.suggestProvider === 'ollama' || (s.localDraft !== false && s.provider === 'deepseek');
  if (!needsLocal || !s.ollamaModel || Date.now() - lastWarm < 120000) return;
  lastWarm = Date.now();
  fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.ollamaModel, prompt: '', keep_alive: '30m' }),
  }).catch(() => {});
}
function resetWarmup() {
  lastWarm = 0;
}

async function listOllamaModels() {
  const res = await fetch('http://localhost:11434/api/tags');
  if (!res.ok) throw new Error('Ollama không phản hồi');
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

module.exports = {
  translate,
  suggest,
  wantReply,
  warmup,
  resetWarmup,
  prewarmNet,
  listOllamaModels,
  _internals: { parseReply, isEcho, cutForeign, FOREIGN, suggestSystem, suggestShots, unverifiedClaims, cleanTranslation, isRepeatRequest, unwrapQuotes, translateSystem },
};
