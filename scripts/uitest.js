#!/usr/bin/env node
// Kiểm thử giao diện gợi ý (xếp chồng theo lượt, thu gọn, bỏ gợi ý cũ...) bằng DOM giả lập: node scripts/uitest.js
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dir = require('path').join(__dirname, '..', 'src', 'renderer') + require('path').sep;
const html = fs.readFileSync(dir + 'index.html', 'utf8').replace('<script src="renderer.js"></script>', '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const cb = {};
const sent = [];
const on = (name) => (fn) => {
  cb[name] = fn;
};
w.api = {
  sendAudio() {}, setListening() {}, logEvent: (t, d) => sent.push([t, d]), clearHistory() {}, getSettings: async () => ({}), saveSettings: async () => ({}),
  ollamaModels: async () => [], toggleClickThrough() {}, minimize() {}, close() {}, openLogFolder() {}, toggleLog: async () => ({}), logState: async () => ({}),
  onUtterance: on('utt'), onTranslation: on('tr'), onRepliesWait: on('wait'), onRepliesStart: on('start'), onReply: on('reply'), onRepliesEnd: on('end'),
  onStatus: on('status'), onClickThrough: on('ct'), onBanner: on('banner'), onLogState: on('log'),
  onSpeakerMe: on('speakerMe'), setMeSpeaker: (v) => sent.push(['setMe', v]),
};
Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });
w.eval(fs.readFileSync(dir + 'renderer.js', 'utf8'));
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
let ok = 0;
const t = (name, cond) => {
  console.log((cond ? 'ok  - ' : 'FAIL - ') + name);
  if (!cond) process.exitCode = 1;
  else ok++;
};

// Lượt 1: bắt đầu nghe -> nghĩ -> 3 gợi ý
cb.wait({ id: 1, turnNo: 1 });
t('đang nghe: hiện trạng thái, chưa có nhóm', $('#sgStatus').textContent.includes('Đang nghe') && $$('.sg-group').length === 0);
cb.start({ id: 1, turnNo: 1, expected: true, q: 'Can you send me the report by Friday?' });
t('replies-start xoá trạng thái và tạo nhóm mở sẵn', $('#sgStatus').textContent === '' && $$('.sg-group').length === 1 && !$('.sg-group').classList.contains('collapsed'));
t('nhóm có tiêu đề là câu của họ', $('.sg-head').textContent.includes('report by Friday'));
for (const en of ['Sure.', 'Which one?', 'Maybe Monday?']) cb.reply({ id: 1, turnNo: 1, en, vi: 'vi ' + en });
t('3 thẻ trong nhóm 1', $$('.sg-group .card').length === 3);
cb.end({ id: 1, turnNo: 1, count: 3 });

// Lượt 2 bắt đầu: bộ cũ PHẢI còn nguyên
cb.wait({ id: 5, turnNo: 2 });
t('lượt mới bắt đầu: bộ gợi ý cũ vẫn còn đủ 3 thẻ', $$('.sg-group .card').length === 3);
cb.start({ id: 5, turnNo: 2, expected: true, q: 'Do you like spicy food?' });
t(
  'hai nhóm; nhóm mới ở trên cùng và mở, nhóm cũ thu gọn',
  $$('.sg-group').length === 2 &&
    $$('.sg-group')[0].querySelector('.sg-head').textContent.includes('spicy') &&
    !$$('.sg-group')[0].classList.contains('collapsed') &&
    $$('.sg-group')[1].classList.contains('collapsed')
);
// Gợi ý trễ của lần chạy cũ (id khác) bị bỏ qua, nhưng của lần chạy mới thì nhận
cb.reply({ id: 4, turnNo: 2, en: 'STALE', vi: '' });
cb.reply({ id: 5, turnNo: 2, en: 'Yes, I like it.', vi: 'Có.' });
t('gợi ý của id cũ bị bỏ, id mới được nhận', $$('.sg-group')[0].querySelectorAll('.card').length === 1 && !$('.sg-group').textContent.includes('STALE'));

// Mid-turn rồi cuối lượt cho cùng lượt 2: bộ cuối thay bộ mid trong CÙNG nhóm
cb.start({ id: 7, turnNo: 2, expected: true, q: 'Do you like spicy food? There is a noodle stall.' });
t('start lại cùng lượt: vẫn 2 nhóm và nhóm 2 được làm mới', $$('.sg-group').length === 2 && $$('.sg-group')[0].querySelectorAll('.card').length === 0);
cb.reply({ id: 5, turnNo: 2, en: 'OLD STREAM', vi: '' });
cb.reply({ id: 7, turnNo: 2, en: 'New set 1', vi: '' });
t('stream cũ của cùng lượt bị bỏ, stream mới được nhận', $$('.sg-group')[0].textContent.includes('New set 1') && !$$('.sg-group')[0].textContent.includes('OLD STREAM'));

// Bấm tiêu đề nhóm cũ để mở lại, rồi copy ghi log kèm số lượt
$$('.sg-group')[1].querySelector('.sg-head').click();
t('bấm tiêu đề mở lại nhóm cũ', !$$('.sg-group')[1].classList.contains('collapsed'));
$$('.sg-group')[1].querySelector('.card').click();
t('copy từ bộ cũ được ghi log kèm turnNo', sent.some(([type, d]) => type === 'copy' && d.turnNo === 1 && d.en === 'Sure.'));

// Dừng nghe: không xoá gợi ý, chỉ đổi trạng thái
cb.wait({ id: -1, stopped: true });
t('dừng nghe: giữ nguyên các nhóm, trạng thái "Đã dừng nghe."', $$('.sg-group').length === 2 && $('#sgStatus').textContent.includes('Đã dừng'));

// Giới hạn số nhóm
for (let n = 3; n <= 9; n++) cb.start({ id: 100 + n, turnNo: n, expected: true, q: 'q' + n });
t('tối đa 5 nhóm, nhóm cũ nhất bị bỏ', $$('.sg-group').length === 5);
// Câu không cần trả lời + lỗi
cb.start({ id: 200, turnNo: 20, expected: false, q: 'Okay.' });
t('câu không cần trả lời hiện ghi chú trong nhóm', $$('.sg-group')[0].textContent.includes('không cần trả lời'));
cb.start({ id: 201, turnNo: 21, expected: true, q: 'Q' });
cb.end({ id: 201, turnNo: 21, count: 0, error: 'timeout' });
t('lỗi gợi ý hiện trong nhóm, không xoá nhóm khác', $$('.sg-group')[0].textContent.includes('Lỗi gợi ý') && $$('.sg-group').length === 5);
// Xoá hội thoại
$('#btnClear').click();
t('nút xoá dọn sạch nhóm', $$('.sg-group').length === 0 && $('#cards').children.length === 0);
// ---- Nhiều người nói: nhãn A/B, đánh dấu "đây là tôi", tiêu đề bộ gợi ý có nhãn ----
cb.utt({ id: 301, en: 'Hey, are you free?', final: true, spk: 0 });
cb.utt({ id: 302, en: 'Sure, what do you have in mind?', final: true, spk: 1 });
cb.utt({ id: 303, en: 'A night market.', final: true, spk: 0 });
const chips = () => $$('.utt .chip');
const utts = () => $$('.utt');
t('mỗi câu có nhãn người nói đúng chữ cái (A, B, A)', chips().map((c) => c.textContent).join('') === 'ABA');
t('nhãn có màu theo người (s0, s1)', chips()[0].classList.contains('s0') && chips()[1].classList.contains('s1'));
t('chữ tiếng Anh nằm cạnh nhãn', utts()[utts().length - 3].textContent.includes('Hey, are you free?'));
cb.utt({ id: 301, en: 'Hey, are you free this Saturday?', final: true, spk: 0 });
t('cập nhật chữ không nhân đôi nhãn và không mất nhãn', utts()[utts().length - 3].querySelectorAll('.chip').length === 1 && utts()[utts().length - 3].textContent.includes('this Saturday'));
chips()[1].click();
t('bấm nhãn gửi yêu cầu đánh dấu "đây là tôi" cho người B (1)', sent.some(([k, v]) => k === 'setMe' && v === 1));
cb.speakerMe(1);
t(
  'sau khi main xác nhận: câu của B được tô là "tôi", câu của A thì không',
  utts()[utts().length - 2].classList.contains('me') && !utts()[utts().length - 3].classList.contains('me') && chips()[1].classList.contains('me')
);
chips()[1].click();
t('bấm lại nhãn đang là "tôi" thì gửi null để bỏ đánh dấu', sent.filter(([k]) => k === 'setMe').pop()[1] === null);
cb.speakerMe(null);
t('bỏ đánh dấu: không còn câu nào là "tôi"', $$('.utt.me').length === 0);
cb.start({ id: 310, turnNo: 40, expected: true, q: 'A night market.', spk: 0 });
t('tiêu đề bộ gợi ý có nhãn người nói [A]', $$('.sg-group')[0].querySelector('.sg-head').textContent.includes('[A]'));
cb.start({ id: 311, turnNo: 41, expected: true, q: 'No label.' });
t('không có người nói thì tiêu đề không có nhãn', !$$('.sg-group')[0].querySelector('.sg-head').textContent.includes('['));

// ---- Đoạn bị bỏ (nhiễu, quá ngắn, không ra chữ): dòng chữ tạm đã hiện phải biến mất ----
const before = $$('.utt').length;
cb.utt({ id: 900, en: 'Thank you.', final: false });
t('chữ tạm của đoạn đang nói hiện lên như bình thường', $$('.utt').length === before + 1 && $$('.utt')[$$('.utt').length - 1].textContent.includes('Thank you.'));
cb.utt({ id: 900, dropped: true });
t('đoạn bị bỏ: dòng chữ tạm bị xoá, các dòng khác còn nguyên', $$('.utt').length === before && !$('#feed').textContent.includes('Thank you.'));
cb.utt({ id: 901, dropped: true });
t('báo bỏ một đoạn chưa từng hiện chữ: không lỗi, không tạo dòng mới', $$('.utt').length === before);

console.log(`\n${ok} kiểm tra đạt`);
