"""Theo dõi người nói trực tuyến: gán mỗi đoạn nói vào một người (A, B, C…) theo độ giống của vector giọng.

Chỉ dùng numpy nên kiểm thử được mà không cần model. Vector giọng lấy từ model titanet (sherpa-onnx), xem server.py.
Số đo trên dữ liệu thật: cùng người ~0,6–0,8; khác người <= 0,2 (giọng người thật); với 2 giọng tổng hợp:
cùng giọng >= 0,50, khác giọng <= 0,35. Ngưỡng mặc định 0,42 nằm giữa hai nhóm.
"""
import numpy as np

MIN_SPEECH_FOR_NEW = 1.0  # đoạn ngắn hơn (giây) thì vector không đáng tin: không tạo người mới, không cập nhật
MAX_SPEAKERS = 8


def _unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


class SpeakerTracker:
    def __init__(self, threshold=0.42, max_speakers=MAX_SPEAKERS):
        self.threshold = float(threshold)
        self.max_speakers = max_speakers
        self.sums = []  # tổng các vector đã gán cho từng người (tâm cụm = tổng / |tổng|)
        self.last = None  # người nói của đoạn trước

    def reset(self):
        self.sums = []
        self.last = None

    def centroids(self):
        return [_unit(s) for s in self.sums]

    def assign(self, emb, speech_s):
        """Trả về (người, độ_giống_cao_nhất, là_người_mới, danh_sách_độ_giống)."""
        e = _unit(emb)
        long_enough = speech_s >= MIN_SPEECH_FOR_NEW

        if not self.sums:
            self.sums.append(e.copy())
            self.last = 0
            return 0, 1.0, True, []

        sims = [float(e @ c) for c in self.centroids()]
        best = int(np.argmax(sims))
        best_sim = sims[best]

        if best_sim >= self.threshold:
            who, is_new = best, False
        elif not long_enough:
            who, is_new = (self.last if self.last is not None else best), False  # đoạn ngắn không rõ: giữ người trước
        elif len(self.sums) < self.max_speakers:
            self.sums.append(np.zeros_like(e))
            who, is_new = len(self.sums) - 1, True
        else:
            who, is_new = best, False

        if long_enough and (is_new or sims[who] >= self.threshold):
            self.sums[who] = self.sums[who] + e  # cập nhật tâm cụm bằng vector đáng tin
        self.last = who
        return who, best_sim, is_new, [round(s, 2) for s in sims]
