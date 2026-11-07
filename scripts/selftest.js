#!/usr/bin/env node
// Kiểm thử nhanh logic thuần (không cần GPU/mạng): node scripts/selftest.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const llm = require('../src/main/llm');
const { SessionLog } = require('../src/main/sessionlog');
const { parseReply, isEcho, cutForeign, FOREIGN, suggestSystem, suggestShots, unverifiedClaims, cleanTranslation, isRepeatRequest } = llm._internals;
const { isNonEnglish, isPhantom, fixStt, fixGlossary, endsWithQuestion } = require('../src/main/lang');

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('ok  -', name);
  } catch (e) {
    console.error('FAIL -', name, '\n    ', e.message);
    process.exitCode = 1;
  }
};

t('parseReply: tách EN || VI', () => {
  const r = parseReply('Sure, I can do that. || Được, tôi làm được.');
  assert.deepStrictEqual(r, { en: 'Sure, I can do that.', vi: 'Được, tôi làm được.' });
});
t('parseReply: bỏ số thứ tự và gạch đầu dòng', () => {
  assert.strictEqual(parseReply('1. Sure thing. || Được.').en, 'Sure thing.');
  assert.strictEqual(parseReply('- Sure thing. || Được.').en, 'Sure thing.');
});
t('parseReply: bỏ nhãn model thêm vào', () => {
  const r = parseReply('English reply: "Sounds good." || Vietnamese translation: Nghe ổn đấy.');
  assert.deepStrictEqual(r, { en: 'Sounds good.', vi: 'Nghe ổn đấy.' });
});
t('parseReply: loại dòng toàn tiếng Việt ở phần EN', () => {
  assert.strictEqual(parseReply('Được rồi, chúng ta kết thúc. || Được rồi.'), null);
});
t('parseReply: loại dòng chép lại khuôn mẫu', () => {
  assert.strictEqual(parseReply('English reply || Vietnamese translation'), null);
});
t('parseReply: loại gợi ý EN lẫn chữ Hán, cắt chữ Hán trong VI', () => {
  assert.strictEqual(parseReply('Sure 好的 || ok'), null);
  assert.strictEqual(parseReply('Sure. || Được rồi生成').vi, 'Được rồi');
});
t('parseReply: thiếu bản dịch vẫn giữ phần EN', () => {
  assert.deepStrictEqual(parseReply('Sure, absolutely.'), { en: 'Sure, absolutely.', vi: '' });
});
t('isEcho: lặp lại câu hỏi bị loại, trả lời thật thì giữ', () => {
  const q = 'Can you give us a discount on the annual plan?';
  assert.ok(isEcho('Can you give us a discount on the annual plan?', q));
  assert.ok(!isEcho('Sure, we can offer ten percent off.', q));
  assert.ok(!isEcho('Yes', q)); // quá ngắn: không coi là lặp
});
t('FOREIGN/cutForeign', () => {
  assert.ok(FOREIGN.test('abc 生成'));
  assert.ok(FOREIGN.test('Да'));
  assert.ok(!FOREIGN.test('Chúng tôi đã chuyển dữ liệu'));
  assert.strictEqual(cutForeign('cách生成abc'), 'cách');
});
t('wantReply: câu đệm/ngắn không gợi ý', () => {
  assert.ok(!llm.wantReply('Okay.'));
  assert.ok(!llm.wantReply('Yeah'));
  assert.ok(!llm.wantReply('Thank you'));
  assert.ok(llm.wantReply('Can you send me the report by Friday?'));
});

t('suggestSystem: có vai trò người dùng và quy tắc cấm bịa dữ kiện', () => {
  const base = { style: 'concise', replyLength: 'medium', context: '', glossary: '' };
  const withPersona = suggestSystem({ ...base, persona: 'Tôi là ứng viên sales, 2 năm kinh nghiệm B2B' });
  assert.ok(withPersona.includes('Tôi là ứng viên sales, 2 năm kinh nghiệm B2B'));
  assert.ok(withPersona.includes('ONLY facts you know about them'));
  assert.ok(/Do NOT invent personal facts/.test(withPersona));
  assert.ok(/placeholder in square brackets/.test(withPersona));
  const noPersona = suggestSystem({ ...base, persona: '' });
  assert.ok(!noPersona.includes('ONLY facts you know about them'), 'không persona thì không có dòng vai trò');
  assert.ok(/Do NOT invent personal facts/.test(noPersona), 'quy tắc cấm bịa luôn có');
});

t('unverifiedClaims: con số tự thêm bị cảnh báo, con số có trong hội thoại thì không', () => {
  const q = 'Can you lend us two people for the next month? We need them by Friday.';
  assert.deepStrictEqual(unverifiedClaims('Yes, I can lend you two people for the next month.', q, false), []);
  assert.deepStrictEqual(unverifiedClaims('Yes, I can lend you 2 people.', q, false), []); // 2 = two
  assert.ok(unverifiedClaims('I can get back to you in five minutes.', q, false).some((w) => /con số/.test(w)));
  assert.ok(unverifiedClaims('We can offer a 10% discount.', q, false).some((w) => /10/.test(w)));
  assert.deepStrictEqual(unverifiedClaims('I have [number of years] of experience.', q, false), []); // chỗ trống hợp lệ
  assert.deepStrictEqual(unverifiedClaims('I can start in 3 weeks.', q + ' Persona: available in 3 weeks', true), []); // có trong thông tin của bạn
});
t('unverifiedClaims: kinh nghiệm/thành tích chưa khai bị cảnh báo, có chỗ trống thì không', () => {
  const q = 'Tell me about your experience and biggest achievement.';
  // Đúng ca đã thấy trong log phỏng vấn thật:
  const bad = unverifiedClaims('My biggest achievement was helping my team reach its targets.', q, false);
  assert.ok(bad.some((w) => /kinh nghiệm|thành tích/.test(w)), 'phải cảnh báo thành tích tự đặt');
  assert.ok(unverifiedClaims('I worked at my last company for a while.', q, false).length > 0);
  assert.deepStrictEqual(unverifiedClaims('My biggest achievement was [your achievement].', q, false), []);
  assert.deepStrictEqual(unverifiedClaims('I have [number of years] of experience in [your field].', q, false), []);
  // Có persona thì không cảnh báo kiểu "chưa khai" (người dùng đã khai dữ kiện)
  assert.deepStrictEqual(unverifiedClaims('My biggest achievement was closing a big deal.', q, true), []);
});
t('unverifiedClaims: bịa cuộc trao đổi trước đó bị cảnh báo (kể cả khi có persona)', () => {
  const q = 'What is your expected salary?';
  const w = unverifiedClaims('Let me confirm the salary range we discussed earlier.', q, true);
  assert.ok(w.some((x) => /trao đổi trước/.test(x)), 'phải cảnh báo');
  assert.deepStrictEqual(unverifiedClaims('As we discussed earlier, I can start soon.', 'As we discussed earlier, when can you start?', true), []);
});
t('isNonEnglish: tiếng Việt/Trung bị bỏ qua, tiếng Anh thường (kể cả dấu cong, 1 ký tự có dấu) thì không', () => {
  assert.ok(isNonEnglish('Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn'));
  assert.ok(isNonEnglish('Chúng tôi đã chuyển dữ liệu'));
  assert.ok(isNonEnglish('你好世界这是一段中文'));
  assert.ok(isNonEnglish('Привет мир это русский текст'));
  assert.ok(!isNonEnglish("I’d like to order a café latte, please."));
  assert.ok(!isNonEnglish('Our CEO said “we’re fine” — right?'));
  assert.ok(!isNonEnglish('Can you lend us two people from your team for the next month?'));
  assert.ok(!isNonEnglish(''));
  assert.ok(!isNonEnglish('Okay.'));
});
t('replyLevel: simple có luật mức A2-B1 + ví dụ mẫu ngắn; natural không có', () => {
  const base = { style: 'concise', replyLength: 'medium', persona: '' };
  const simple = suggestSystem({ ...base, replyLevel: 'simple' });
  const natural = suggestSystem({ ...base, replyLevel: 'natural' });
  assert.ok(/SIMPLE words but NATURAL/.test(simple) && !/SIMPLE words/.test(natural));
  assert.ok(/educated native speaker/.test(natural) && !/educated native speaker/.test(simple));
  assert.ok(/NEVER mention their English level/.test(simple) && /NEVER mention their English level/.test(natural));
  assert.ok(/Option 1 must ALWAYS be a direct answer/.test(simple));
  const shotS = suggestShots({ ...base, replyLevel: 'simple' })[1].content;
  const shotN = suggestShots({ ...base, replyLevel: 'natural' })[1].content;
  assert.notStrictEqual(shotS, shotN, 'ví dụ mẫu phải khác nhau theo mức');
  const longest = (txt) => Math.max(...txt.split('\n').map((l) => l.split('||')[0].trim().split(/\s+/).length));
  assert.ok(longest(shotS) <= longest(shotN), 'ví dụ simple không dài hơn natural');
  assert.ok(suggestShots({ ...base, replyLevel: undefined })[1].content === shotS, 'mặc định là simple');
});
t('diarize: prompt nói rõ "Me:" là lời đã nói của người dùng; tắt thì không có', () => {
  const base = { style: 'concise', replyLength: 'medium', persona: '', replyLevel: 'simple' };
  const on = suggestSystem({ ...base, diarize: true });
  const off = suggestSystem({ ...base, diarize: false });
  assert.ok(/lines starting with "Me:" are what the Vietnamese speaker ALREADY said/.test(on));
  assert.ok(/Reply to the latest speaker only/.test(on));
  assert.ok(!/Me:/.test(off), 'tắt nhiều người nói thì prompt như cũ');
});
t('suggestSystem: có quy tắc dịch chỗ trống sang tiếng Việt và ví dụ vai trò', () => {
  const s = suggestSystem({ style: 'concise', replyLength: 'medium', persona: '' });
  assert.ok(/translate the text inside the brackets into Vietnamese/.test(s));
  assert.ok(/\[your achievement\]/.test(s));
  assert.ok(/I helped my team reach its targets/.test(s), 'có nêu đúng ví dụ bịa đã thấy');
});

t('SessionLog: ghi JSONL, đếm sự kiện, đóng phiên', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-log-'));
  const log = new SessionLog();
  assert.ok(log.start(dir, { settings: { provider: 'ollama', vadThreshold: 0.008 } }));
  log.event('stt_final', { id: 0, text: 'Hello there.', dur: 1.5, proc_ms: 300, reason: 'silence', rms_voiced: 0.05, rms_quiet: 0.001 });
  log.event('translate', { id: 0, ms: 250, provider: 'ollama', vi: 'Xin chào.' });
  log.event('suggest', { id: 0, provider: 'deepseek', first_ms: 900, total_ms: 1800, count: 3, replies: [{ en: 'Hi!', vi: 'Chào!' }], tok_in: 800, tok_out: 250, usd_upper: 0.0005 });
  log.stop();
  const lines = fs.readFileSync(path.join(log.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map((l) => l.type), ['session_start', 'stt_final', 'translate', 'suggest', 'session_end']);
  assert.strictEqual(lines[4].counts.stt_final, 1);
  log.event('x'); // sau khi dừng không ghi nữa
  assert.strictEqual(fs.readFileSync(path.join(log.dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 5);
  // Script phân tích đọc được log vừa ghi
  const out = execFileSync(process.execPath, [path.join(__dirname, 'analyze-log.js'), log.dir], { encoding: 'utf8' });
  assert.ok(/Câu chốt: 1/.test(out), 'analyzer phải thấy 1 câu chốt');
  assert.ok(/Hoàn tất 1/.test(out), 'analyzer phải thấy 1 gợi ý');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Từ log thật (buổi luyện nói với gia sư): bản dịch cụt và gợi ý lặp câu bị lọc nhầm ----
t('cleanTranslation: ghép mọi dòng (đoạn 2 câu không bị cụt như log thật #13)', () => {
  assert.strictEqual(
    cleanTranslation('Điều tôi thích nhất là tôi tiết kiệm thời gian.\nNếu không có "that", nghe như hai câu dính vào nhau.'),
    'Điều tôi thích nhất là tôi tiết kiệm thời gian. Nếu không có "that", nghe như hai câu dính vào nhau.'
  );
  assert.strictEqual(cleanTranslation('"Xin chào."'), 'Xin chào.');
  assert.strictEqual(cleanTranslation('\n\n  Một dòng  \n'), 'Một dòng');
});
t('cleanTranslation: giữ dấu ngoặc kép hợp lệ (lỗi thật ở log #64, #84)', () => {
  assert.strictEqual(cleanTranslation('"I\'d" là viết tắt của "I would".'), '"I\'d" là viết tắt của "I would".');
  assert.strictEqual(cleanTranslation('khi bạn đang sửa câu "got up and had breakfast"'), 'khi bạn đang sửa câu "got up and had breakfast"');
  assert.strictEqual(cleanTranslation('"Chỉ cần làm một chút" và "bắt đầu với một chút"'), '"Chỉ cần làm một chút" và "bắt đầu với một chút"');
  assert.strictEqual(cleanTranslation('“Xin chào.”'), 'Xin chào.'); // ngoặc bao cả câu vẫn được bỏ
});
t('parseReply: không cắt nhầm ngoặc kép trong bản dịch của gợi ý', () => {
  const r = parseReply('Say "after a workout". || Hãy nói "after a workout".');
  assert.strictEqual(r.en, 'Say "after a workout".');
  assert.strictEqual(r.vi, 'Hãy nói "after a workout".');
});
t('fixStt: "say at once" (lỗi nhận dạng lặp lại của gia sư) thành "say it once"; câu khác giữ nguyên', () => {
  assert.strictEqual(fixStt('Say at once I like it because it is funny'), 'Say it once I like it because it is funny');
  assert.strictEqual(fixStt('Please say a once more'), 'Please say it once more');
  assert.strictEqual(fixStt('Stay at once'), 'Stay at once');
  assert.strictEqual(fixStt('Come at once, please.'), 'Come at once, please.');
  assert.strictEqual(fixStt(''), '');
});
t('dịch: prompt có quy tắc câu hỏi phải dịch đủ và lỗi gia sư trích lại phải giữ nguyên', () => {
  const sys = llm._internals.translateSystem({ context: 'Buổi luyện nói tiếng Anh với gia sư AI' });
  assert.ok(/translate the whole question/i.test(sys) && /NEVER silently correct/.test(sys));
  // Hội thoại thường (log thật: voice chat, nhà hàng): KHÔNG áp luật gia sư, từ lẻ dịch thẳng không chú thích
  const plain = llm._internals.translateSystem({ context: 'Trò chuyện đời thường với người nước ngoài' });
  assert.ok(!/language tutor/.test(plain) && !/NEVER silently correct/.test(plain) && /short fragment or filler/.test(plain));
  assert.ok(/homophones/.test(plain), 'luật từ đồng âm áp dụng cho mọi ngữ cảnh');
  // Chế độ chọn rõ thì thắng việc đoán theo chữ trong bối cảnh
  const chatMode = llm._internals.translateSystem({ mode: 'chat', context: 'Buổi luyện với gia sư' });
  const tutorMode = llm._internals.translateSystem({ mode: 'tutor', context: '' });
  assert.ok(!/language tutor/.test(chatMode) && /language tutor/.test(tutorMode));
});
t('fixGlossary: tên riêng bị nghe gần đúng ("Con", "Cong") được sửa thành "Kong"; từ thường giữ nguyên', () => {
  assert.strictEqual(fixGlossary('Perfect con no fixes', 'Kong'), 'Perfect Kong no fixes');
  assert.strictEqual(fixGlossary("That's right, Cong.", 'Kong'), "That's right, Kong.");
  assert.strictEqual(fixGlossary('He is a con artist', 'Kong'), 'He is a con artist');
  assert.strictEqual(fixGlossary('A good coin and corn', 'Kong'), 'A good coin and corn');
  assert.strictEqual(fixGlossary('Perfect con', ''), 'Perfect con');
});
t('endsWithQuestion: câu hỏi trọn vẹn ở cuối đoạn thì true, câu thường và "Question N" đứng một mình thì false', () => {
  assert.ok(endsWithQuestion("What's something that made you laugh recently"));
  assert.ok(endsWithQuestion("Perfect Kong no fixes. Question fourteen What's the best piece of advice anyone has ever given you"));
  assert.ok(endsWithQuestion('Is that okay with you?'));
  assert.ok(endsWithQuestion('Hi there, what can I get for you today'));
  assert.ok(endsWithQuestion('Sure, just the burger or do you want the combo'));
  assert.ok(endsWithQuestion('Small, medium, or large'));
  assert.ok(endsWithQuestion('No problem, no onions for here or to go'));
  assert.ok(!endsWithQuestion('Your total is twelve fifty') && !endsWithQuestion('Of course, enjoy your meal'));
  assert.ok(!endsWithQuestion('Question fourteen'));
  assert.ok(!endsWithQuestion('Perfect, Kong.'));
  assert.ok(!endsWithQuestion('What I mean is simple and short'));
  assert.ok(!endsWithQuestion('Say it once the most useful app on my phone is clock'));
});
t('gợi ý: prompt đòi tiếng Anh tự nhiên (viết tắt), gọi người kia là "bạn"; ví dụ mẫu không còn "anh/chị"', () => {
  const sys = llm._internals.suggestSystem({ replyLevel: 'simple', replyLength: 'long' });
  assert.ok(/contractions/i.test(sys) && /learn to cook/.test(sys) && /"bạn"/.test(sys));
  const shots = JSON.stringify(llm._internals.suggestShots({ replyLevel: 'simple', replyLength: 'long' }));
  assert.ok(!shots.includes('anh/chị'), 'ví dụ mẫu dạy model dùng "anh/chị"');
});
t('isPhantom: "Thank you."/"you" từ tiếng ồn nhỏ bị loại, giọng thật hoặc câu khác thì giữ (số đo từ log thật)', () => {
  assert.ok(isPhantom('Thank you.', 0.0147)); // log thật #39
  assert.ok(isPhantom('you', 0.0108)); // log thật #42
  assert.ok(isPhantom('Thank you.', 0.0138)); // log thật #50
  assert.ok(isPhantom('Thanks for watching!', 0.012));
  assert.ok(!isPhantom('Thank you.', 0.06), 'nói "Thank you." bình thường thì giữ');
  assert.ok(!isPhantom('Good luck.', 0.02), 'câu thật nhỏ nhất trong log, không thuộc cụm ảo giác');
  assert.ok(!isPhantom('Thank you, Kong.', 0.012), 'câu dài hơn cụm ảo giác thì giữ');
  assert.ok(!isPhantom('you', 0.05));
  assert.ok(!isPhantom('', 0.01) && !isPhantom('Thank you.', undefined));
});
t('translateSystem: giữ tiếng Anh phần trích dẫn, xử lý từ lẻ đang tập, không còn cấm mọi dấu ngoặc', () => {
  const sys = llm._internals.translateSystem({ context: 'gia sư', glossary: '' });
  assert.ok(/must stay in English, inside quotation marks/.test(sys));
  assert.ok(/A word being discussed is a WORD/.test(sys));
  assert.ok(/only one or two words/.test(sys));
  assert.ok(!/no quotes/.test(sys), 'quy tắc cũ "no quotes" mâu thuẫn với luật mới');
  assert.ok(/Conversation context: gia sư/.test(sys));
});
t('cleanTranslation: từ lẻ kèm giải nghĩa giữ nguyên dấu ngoặc kép', () => {
  assert.strictEqual(cleanTranslation('"I\'d" (viết tắt của I would)'), '"I\'d" (viết tắt của I would)');
  assert.strictEqual(cleanTranslation('Và từ "because" nối hai câu rất mượt.'), 'Và từ "because" nối hai câu rất mượt.');
});
t('cleanTranslation: dừng ở dòng giả lập lượt hội thoại do model "trôi"', () => {
  assert.strictEqual(cleanTranslation('Chúng tôi đã chuyển dữ liệu.\nuser\n继续翻译这句话'), 'Chúng tôi đã chuyển dữ liệu.');
  assert.strictEqual(cleanTranslation('Câu dịch.\nassistant: thêm gì đó'), 'Câu dịch.');
});
t('isRepeatRequest: nhận ra yêu cầu nói lại/bắt đầu bằng câu cụ thể', () => {
  assert.ok(isRepeatRequest('Say it once, my favourite thing about training at home is that I save time.'));
  assert.ok(isRepeatRequest('Say it once more. I would tell them to start small.'));
  assert.ok(isRepeatRequest('Start with, my favourite thing about training at home is...'));
  assert.ok(isRepeatRequest('Please repeat after me.'));
  assert.ok(!isRepeatRequest('Can you give us a discount on the annual plan?'));
  assert.ok(!isRepeatRequest('Question 9. If a friend asked you for gym advice, what would you tell them?'));
});

// Gọi suggest() với phản hồi stream giả lập (không cần mạng) để kiểm tra bộ lọc lặp câu hỏi.
async function runSuggest(turnText, lines) {
  const realFetch = global.fetch;
  const sse =
    lines.map((l) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: l + '\n' } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(sse);
  global.fetch = async () => {
    let sent = false;
    return { ok: true, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }) } };
  };
  try {
    const got = [];
    await llm.suggest({ provider: 'ollama', ollamaModel: 'x', style: 'concise', replyLength: 'short', replyLevel: 'simple' }, [], turnText, (r) => got.push(r.en));
    return got;
  } finally {
    global.fetch = realFetch;
  }
}

const asyncTests = [];
const ta = (name, fn) =>
  asyncTests.push(
    fn().then(
      () => {
        passed += 1;
        console.log('ok  -', name);
      },
      (e) => {
        console.error('FAIL -', name, '\n    ', e.message);
        process.exitCode = 1;
      }
    )
  );

const repeatLine = 'My favourite thing about training at home is that I save time. || Điều tôi thích nhất là tiết kiệm thời gian.';
const other1 = 'My favourite thing about training at home is that I save time. I save money too. || Tôi tiết kiệm thời gian và tiền.';
const other2 = 'Can I say it again slowly? || Tôi nói lại chậm được không?';
ta('suggest: được yêu cầu "Say it once, <câu>" thì gợi ý lặp đúng câu đó KHÔNG bị lọc', async () => {
  const got = await runSuggest('Say it once, my favourite thing about training at home is that I save time.', [repeatLine, other1, other2]);
  assert.strictEqual(got.length, 3, `phải giữ đủ 3 gợi ý, nhận ${got.length}`);
  assert.strictEqual(got[0], 'My favourite thing about training at home is that I save time.');
});
ta('suggest: câu hỏi thường mà gợi ý chỉ lặp lại câu hỏi thì vẫn bị lọc', async () => {
  const q = 'Can you give us a discount on the annual plan?';
  const got = await runSuggest(q, [
    'Can you give us a discount on the annual plan? || Bạn giảm giá được không?',
    'Sure, we can offer ten percent. || Được.',
    'Let me check with my team. || Để tôi hỏi nhóm.',
    'I need more time to decide. || Tôi cần thêm thời gian.',
  ]);
  assert.ok(!got.includes('Can you give us a discount on the annual plan?'), 'gợi ý lặp lại câu hỏi phải bị lọc');
  assert.strictEqual(got.length, 3);
});

// ---- Deepgram Flux: đổi sự kiện sang dạng tin nhắn của sidecar ----
t('deepgram: URL có keyterm lặp lại từng cụm, eager_eot, đúng endpoint v2', () => {
  const { buildUrl, parseKeyterms } = require('../src/main/deepgram');
  const u = buildUrl({ eagerEot: 0.5, keyterms: parseKeyterms('Kong, Acme Corp') });
  assert.ok(u.startsWith('wss://api.deepgram.com/v2/listen?model=flux-general-en'));
  assert.ok(u.includes('keyterm=Kong&keyterm=Acme+Corp') && u.includes('eager_eot_threshold=0.5') && u.includes('encoding=linear16'));
});
t('deepgram: StartOfTurn/Update -> speech+interim (chỉ khi chữ đổi), Eager -> pause, Resumed -> resume, EndOfTurn -> final', () => {
  const { DeepgramFlux } = require('../src/main/deepgram');
  const out = [];
  const d = new DeepgramFlux({ key: 'x', onMessage: (m) => out.push(m), idBase: 7 });
  d.handle({ type: 'Connected' });
  d.handle({ type: 'TurnInfo', event: 'Update', transcript: '' });
  d.handle({ type: 'TurnInfo', event: 'StartOfTurn', transcript: 'Hi there' });
  d.handle({ type: 'TurnInfo', event: 'Update', transcript: 'Hi there' });
  d.handle({ type: 'TurnInfo', event: 'Update', transcript: 'Hi there, what can I get' });
  d.handle({ type: 'TurnInfo', event: 'EagerEndOfTurn', transcript: 'Hi there, what can I get' });
  d.handle({ type: 'TurnInfo', event: 'TurnResumed', transcript: 'Hi there, what can I get for you' });
  d.handle({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'Hi there, what can I get for you?', trigger: 'model',
    words: [{ start: 0.4, end: 0.6 }, { start: 0.6, end: 2.1 }] });
  d.handle({ type: 'TurnInfo', event: 'EndOfTurn', transcript: '' });
  assert.deepStrictEqual(out.map((m) => m.type), ['speech', 'interim', 'interim', 'pause', 'interim', 'resume', 'final', 'dropped']);
  const fin = out.find((m) => m.type === 'final');
  assert.strictEqual(fin.id, 7);
  assert.strictEqual(fin.end_of_turn, true);
  assert.strictEqual(fin.dur, 1.7);
  assert.strictEqual(out[out.length - 1].id, 8, 'lượt sau có id mới');
});

Promise.all(asyncTests).then(() => {
  console.log(`\n${passed} test đạt${process.exitCode ? ', CÓ TEST LỖI' : ''}`);
});
