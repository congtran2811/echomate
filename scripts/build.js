#!/usr/bin/env node
// Đóng gói app thành thư mục chạy được trên Windows: npm run build  ->  dist\Live Interpreter-win32-x64\Live Interpreter.exe
// Chỉ đóng gói vỏ Electron. Whisper (F:\whisper-stt) và Ollama vẫn cài riêng, xem README.
const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');

// Không đưa vào gói: log (chứa nội dung hội thoại), thư mục dist cũ, test, tệp tạm.
const EXCLUDE = [
  /^\/logs($|\/)/,
  /^\/dist($|\/)/,
  /^\/\.git($|\/)/,
  /^\/scripts\/(selftest|uitest|analyze-log|build)\.js$/,
  /^\/stt-server\/test_speakers\.py$/,
  /^\/stt-server\/__pycache__($|\/)/,
  /\.log$/,
];

(async () => {
  const t0 = Date.now();
  console.log('Đóng gói (lần đầu có thể phải tải Electron ~100 MB)…');
  const paths = await packager({
    dir: root,
    name: 'Live Interpreter',
    platform: 'win32',
    arch: 'x64',
    out,
    overwrite: true,
    prune: true, // bỏ devDependencies (jsdom, electron, packager…) khỏi gói
    asar: false, // giữ dạng thư mục thường để ghi log/cấu hình được cạnh app nếu cần
    ignore: EXCLUDE,
    quiet: true,
  });
  const dir = paths[0];
  // Bước prune để lại các thư mục rỗng (@types, @electron…) trong node_modules: dọn cho gọn.
  const removeEmptyDirs = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(d, e.name));
    if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  };
  const nm = path.join(dir, 'resources', 'app', 'node_modules');
  if (fs.existsSync(nm)) for (const e of fs.readdirSync(nm, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(nm, e.name));
  const exe = path.join(dir, 'Live Interpreter.exe');
  if (!fs.existsSync(exe)) throw new Error(`Không thấy ${exe} sau khi đóng gói`);
  const size = (fs.statSync(exe).size / 1048576).toFixed(0);
  console.log(`\nXong sau ${Math.round((Date.now() - t0) / 1000)} giây.`);
  console.log(`Thư mục: ${dir}`);
  console.log(`Chạy: "${exe}" (${size} MB)`);
  console.log('Nhớ: gói này cần Whisper đã cài ở F:\\whisper-stt (npm run setup:whisper) và Ollama đang chạy nếu dùng model local.');
})().catch((e) => {
  console.error('Đóng gói lỗi:', e.message);
  process.exit(1);
});
