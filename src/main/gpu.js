// Đọc mức dùng VRAM/GPU qua nvidia-smi (không có thì trả về null, app vẫn chạy bình thường).
const { execFile } = require('child_process');

function sample() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, out) => {
        if (err) return resolve(null);
        const [used, total, util] = String(out).trim().split(/\s*,\s*/).map(Number);
        if (![used, total].every(Number.isFinite)) return resolve(null);
        resolve({ usedMb: used, totalMb: total, util: Number.isFinite(util) ? util : null });
      }
    );
  });
}

module.exports = { sample };
