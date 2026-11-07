"""Kiểm thử SpeakerTracker bằng vector giả (không cần model): python stt-server/test_speakers.py"""
import os
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")  # terminal Windows mặc định cp1252, không in được tiếng Việt
sys.path.insert(0, os.path.dirname(__file__))
from speakers import MAX_SPEAKERS, SpeakerTracker  # noqa: E402

rng = np.random.default_rng(7)
D = 192


def voice(seed):
    return np.random.default_rng(seed).normal(size=D).astype(np.float32)


def sample(base, noise=0.35):
    """Một lần nói của cùng người: vector gốc + nhiễu."""
    return base + noise * rng.normal(size=D).astype(np.float32)


failed = 0


def check(name, cond):
    global failed
    print(("ok  - " if cond else "FAIL - ") + name)
    if not cond:
        failed += 1


A, B, C = voice(1), voice(2), voice(3)

t = SpeakerTracker(threshold=0.5)
seq = [A, B, A, A, B, C, B, A, C]
got = [t.assign(sample(v), 3.0)[0] for v in seq]
check("người đầu = 0, người khác được tách đúng (A,B,A,A,B,C,B,A,C -> 0,1,0,0,1,2,1,0,2)", got == [0, 1, 0, 0, 1, 2, 1, 0, 2])

t = SpeakerTracker(threshold=0.5)
t.assign(sample(A), 3.0)
who, sim, new, _ = t.assign(sample(B), 0.5)  # đoạn rất ngắn, không giống ai
check("đoạn ngắn không rõ người thì giữ người trước, không tạo người mới", who == 0 and not new and len(t.sums) == 1)

t = SpeakerTracker(threshold=0.5)
t.assign(sample(A), 3.0)
before = t.sums[0].copy()
t.assign(sample(A), 0.4)  # giống A nhưng ngắn: gán A mà không cập nhật tâm cụm
check("đoạn ngắn giống người nào thì gán người đó nhưng không cập nhật tâm cụm", np.allclose(before, t.sums[0]))

t = SpeakerTracker(threshold=0.5, max_speakers=3)
for s in range(10, 20):
    t.assign(sample(voice(s), 0.1), 3.0)
check("không vượt quá số người tối đa", len(t.sums) == 3)
check("MAX_SPEAKERS mặc định là 8", MAX_SPEAKERS == 8)

t = SpeakerTracker(threshold=0.5)
t.assign(sample(A), 3.0)
t.reset()
check("reset xoá hết người nói", t.sums == [] and t.last is None)

# Tâm cụm ổn định hơn một mẫu đơn: nhiều lần nói của A vẫn nhận ra A khi có mẫu nhiễu hơn
t = SpeakerTracker(threshold=0.5)
for _ in range(5):
    t.assign(sample(A, 0.3), 3.0)
t.assign(sample(B, 0.3), 3.0)
who = t.assign(sample(A, 0.7), 3.0)[0]
check("mẫu nhiễu hơn của A vẫn nhận ra là A nhờ tâm cụm", who == 0)

# Ngưỡng cao hơn thì dễ tách thành người mới hơn
hi, lo = SpeakerTracker(threshold=0.95), SpeakerTracker(threshold=0.1)
for v in (A, A, A):
    hi.assign(sample(v, 0.5), 3.0)
    lo.assign(sample(v, 0.5), 3.0)
check("ngưỡng rất cao tách nhiều người, ngưỡng rất thấp gộp thành một", len(hi.sums) > 1 and len(lo.sums) == 1)

print("\nTẤT CẢ ĐẠT" if not failed else f"\n{failed} KIỂM TRA LỖI")
sys.exit(1 if failed else 0)
