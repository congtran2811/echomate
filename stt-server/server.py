"""Whisper STT sidecar: nhận PCM16 16 kHz mono qua WebSocket, trả về chữ tạm (interim) và chữ chốt (final)."""
import argparse
import asyncio
import functools
import json
import os
import site
import sys
import time
import wave

# Thư viện CUDA cài qua pip nằm trong site-packages/nvidia/*/bin, cần nạp trước khi import ctranslate2.
for _sp in site.getsitepackages():
    for _sub in ("cublas", "cudnn"):
        _p = os.path.join(_sp, "nvidia", _sub, "bin")
        if os.path.isdir(_p):
            os.add_dll_directory(_p)
            os.environ["PATH"] = _p + os.pathsep + os.environ["PATH"]

import numpy as np  # noqa: E402
import websockets  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speakers import SpeakerTracker  # noqa: E402

SAMPLE_RATE = 16000
PRE_ROLL_S = 0.3
MAX_UTTERANCE_S = 25  # giới hạn cứng: cắt dù đang nói
SOFT_CUT_S = 12  # quá ngưỡng này thì cắt ở chỗ ngừng ngắn đầu tiên
SOFT_CUT_SILENCE_S = 0.25
MIN_SPEECH_S = 0.4
NEMO_LEAD_S = 0.6
NEMO_PAUSE_S = 0.25  # im lặng bao lâu thì báo "pause" để app dịch đoán trước (Nemotron)  # im lặng đệm đầu đoạn cho Nemotron (xem chỗ dùng)
INTERIM_EVERY_S = 1.0


def log(*a):
    print(*a, flush=True)


# ---- Engine Nemotron (streaming, sherpa-onnx, chạy CPU): chữ ra liên tục khi đang nói ----
def nemo_load(model_dir, threads):
    import sherpa_onnx

    d = model_dir
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=os.path.join(d, "tokens.txt"),
        encoder=os.path.join(d, "encoder.int8.onnx"),
        decoder=os.path.join(d, "decoder.int8.onnx"),
        joiner=os.path.join(d, "joiner.int8.onnx"),
        num_threads=threads,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        enable_endpoint_detection=False,  # chốt câu do VAD năng lượng của sidecar quyết định
    )


def _nemo_text(rec, stream):
    r = rec.get_result(stream)
    return (r if isinstance(r, str) else r.text).strip()


def nemo_feed(rec, stream, chunk):
    stream.accept_waveform(SAMPLE_RATE, chunk)
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    return _nemo_text(rec, stream)


def nemo_finish(rec, stream):
    stream.accept_waveform(SAMPLE_RATE, np.zeros(int(SAMPLE_RATE * 0.4), dtype=np.float32))
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    return _nemo_text(rec, stream)


def transcribe(model, audio, beam, hotwords):
    # Dùng hotwords (tên riêng/thuật ngữ), KHÔNG dùng initial_prompt: thử thực tế cho thấy initial_prompt lệch chủ đề
    # làm Whisper bỏ mất chữ đầu câu ("So tell me, ..." -> "...").
    segments, _ = model.transcribe(
        audio,
        language="en",
        beam_size=beam,
        vad_filter=True,
        condition_on_previous_text=False,
        without_timestamps=True,
        hotwords=hotwords or None,
    )
    return " ".join(s.text.strip() for s in segments).strip()


# ---- Nhận dạng người nói (tuỳ chọn, chạy trên CPU) ----
SPEAKER_MODEL_NAME = "nemo_en_titanet_small.onnx"
_extractor = None
_extractor_state = "chưa nạp"  # "ok" | "thiếu model" | "thiếu thư viện" | lỗi


def speaker_model_path():
    return os.path.join(os.environ.get("HF_HOME", ""), "speaker", SPEAKER_MODEL_NAME)


def get_extractor():
    """Nạp lười bộ trích vector giọng; trả None (kèm lý do) nếu chưa cài model/thư viện."""
    global _extractor, _extractor_state
    if _extractor is not None or _extractor_state not in ("chưa nạp",):
        return _extractor
    path = speaker_model_path()
    if not os.path.isfile(path):
        _extractor_state = "thiếu model"
        return None
    try:
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=2, debug=False, provider="cpu")
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
        _extractor_state = "ok"
    except ImportError:
        _extractor_state = "thiếu thư viện"
    except Exception as e:  # noqa: BLE001
        _extractor_state = f"lỗi: {e!r}"
    return _extractor


def embed(audio):
    ext = get_extractor()
    stream = ext.create_stream()
    stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=audio)
    stream.input_finished()
    return np.array(ext.compute(stream), dtype=np.float32)


def save_wav(directory, name, audio):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return path


async def handle(ws, model, nemo_model=None):
    # Mỗi kết nối chọn engine riêng (cấu hình "engine"): ví dụ giọng người kia chạy Nemotron, micro của bạn chạy Whisper.
    nemo = nemo_model
    loop = asyncio.get_running_loop()
    cfg = {
        "interim": True,
        "silence_ms": 700,
        "threshold": 0.008,
        "hotwords": "",  # tên riêng/thuật ngữ ưu tiên nhận dạng, cách nhau dấu phẩy
        "save_audio_dir": "",  # có đường dẫn thì lưu mỗi đoạn thành file WAV (để chẩn đoán)
        "diarize": False,  # gán người nói (A, B, C…) cho mỗi đoạn
        "speaker_threshold": 0.42,
    }
    tracker = SpeakerTracker(cfg["speaker_threshold"])
    warned_speaker = False
    pre = []  # các chunk gần nhất trước khi bắt đầu nói
    buf = []
    started = False
    speech_s = 0.0
    silence_s = 0.0
    uid = 0
    last_interim = 0.0
    interim_task = None
    voiced_rms = []  # rms các chunk có tiếng, để báo cáo mức âm lượng thật
    quiet_rms = []  # rms các chunk im lặng, để biết mức nhiễu nền
    n_interim = 0
    nstream = None  # luồng nhận dạng Nemotron của đoạn đang nói
    nlast = ""  # chữ tạm gần nhất đã gửi
    nlast_t = 0.0
    ncur = ""  # chữ Nemotron mới nhất của đoạn đang nói
    paused = False  # đã báo "pause" cho khoảng lặng hiện tại

    def total_s():
        return sum(len(c) for c in buf) / SAMPLE_RATE

    async def run(audio, beam):
        try:
            fn = functools.partial(transcribe, model, audio, beam, cfg.get("hotwords"))
            return await loop.run_in_executor(None, fn)
        except Exception as e:  # noqa: BLE001 - ví dụ hết VRAM; không để đứt kết nối
            log(f"WARN transcribe failed: {e!r}")
            return ""

    async def finalize(reason):
        nonlocal buf, started, speech_s, silence_s, uid, interim_task, voiced_rms, quiet_rms, n_interim, nstream, nlast, ncur, paused
        audio = np.concatenate(buf) if buf else None
        enough = speech_s >= MIN_SPEECH_S
        spoke, v_rms, q_rms, interims = speech_s, voiced_rms, quiet_rms, n_interim
        buf, started, speech_s, silence_s = [], False, 0.0, 0.0
        voiced_rms, quiet_rms, n_interim = [], [], 0
        fin_stream, nstream, nlast = nstream, None, ""
        ncur, paused = "", False
        if interim_task is not None:
            await interim_task
            interim_task = None
        cur = uid
        uid += 1
        if audio is None or not enough:
            if audio is not None:
                await ws.send(json.dumps({"type": "dropped", "id": cur, "speech_s": round(spoke, 2)}))
            return
        t0 = time.monotonic()
        if nemo is not None:
            text = ""
            if fin_stream is not None:
                try:
                    text = await loop.run_in_executor(None, nemo_finish, nemo, fin_stream)
                except Exception as e:  # noqa: BLE001
                    log(f"WARN nemotron finish failed: {e!r}")
        else:
            text = await run(audio, int(cfg.get("final_beam", 2)))
        proc_ms = int((time.monotonic() - t0) * 1000)
        spk_meta = {}
        if cfg.get("diarize") and text:
            spk_meta = await assign_speaker(audio, spoke)
        wav = ""
        if cfg.get("save_audio_dir"):
            try:
                wav = save_wav(cfg["save_audio_dir"], f"utt-{int(time.time())}-{cur}.wav", audio)
            except Exception as e:  # noqa: BLE001
                log(f"WARN save wav failed: {e!r}")
        meta = {
            "dur": round(len(audio) / SAMPLE_RATE, 2),
            "speech_s": round(spoke, 2),
            "proc_ms": proc_ms,
            "reason": reason,  # silence | soft | max
            "rms_voiced": round(float(np.mean(v_rms)), 4) if v_rms else 0.0,
            "rms_peak": round(float(np.max(v_rms)), 4) if v_rms else 0.0,
            "rms_quiet": round(float(np.mean(q_rms)), 4) if q_rms else 0.0,
            "threshold": cfg["threshold"],
            "interims": interims,
            "wav": wav,
            **spk_meta,
        }
        if text:
            await ws.send(json.dumps({"type": "final", "id": cur, "text": text, **meta}))
        else:
            # Có tiếng nhưng Whisper không nhận ra chữ nào (nhạc, tiếng ồn…) — báo để dễ chẩn đoán.
            await ws.send(json.dumps({"type": "empty", "id": cur, **meta}))

    async def assign_speaker(audio, speech_s):
        """Gán người nói cho một đoạn đã chốt. Lỗi/thiếu model thì bỏ qua (không có 'spk'), không làm hỏng bản dịch."""
        nonlocal warned_speaker
        if get_extractor() is None:
            if not warned_speaker:
                warned_speaker = True
                await ws.send(json.dumps({"type": "warn", "what": "speaker_" + _extractor_state}))
            return {}
        try:
            t0 = time.monotonic()
            emb = await loop.run_in_executor(None, embed, audio)
            tracker.threshold = float(cfg.get("speaker_threshold", 0.42))
            who, best, is_new, sims = tracker.assign(emb, speech_s)
            return {
                "spk": who,
                "spk_sim": round(best, 2),
                "spk_sims": sims,
                "spk_new": bool(is_new),
                "spk_ms": int((time.monotonic() - t0) * 1000),
            }
        except Exception as e:  # noqa: BLE001
            log(f"WARN speaker embedding failed: {e!r}")
            return {}

    async def send_interim(audio, cur):
        text = await run(audio, 1)
        if text:
            await ws.send(json.dumps({"type": "interim", "id": cur, "text": text}))

    def reset_state():
        # Dừng nghe: bỏ phần âm thanh đang gom dở để không bị chốt/nhận dạng muộn sau khi đã dừng.
        nonlocal pre, buf, started, speech_s, silence_s, voiced_rms, quiet_rms, n_interim, interim_task, nstream, nlast, ncur, paused
        pre, buf, started = [], [], False
        nstream, nlast = None, ""
        ncur, paused = "", False
        speech_s = silence_s = 0.0
        voiced_rms, quiet_rms, n_interim = [], [], 0
        if interim_task is not None and not interim_task.done():
            interim_task.cancel()
        interim_task = None

    async for msg in ws:
        if isinstance(msg, str):
            data = json.loads(msg)
            if data.pop("reset", False):
                reset_state()
            if data.pop("reset_speakers", False):
                tracker.reset()
            eng = data.pop("engine", None)
            if eng == "whisper" and model is not None:
                nemo = None
            elif eng == "nemotron" and nemo_model is not None:
                nemo = nemo_model
            cfg.update(data)
            continue
        chunk = np.frombuffer(msg, dtype=np.int16).astype(np.float32) / 32768.0
        dur = len(chunk) / SAMPLE_RATE
        rms = float(np.sqrt(np.mean(chunk**2))) if len(chunk) else 0.0
        voiced = rms > cfg["threshold"]

        if not started:
            pre.append(chunk)
            while sum(len(c) for c in pre) / SAMPLE_RATE > PRE_ROLL_S:
                pre.pop(0)
            if voiced:
                started = True
                buf = list(pre)
                pre = []
                speech_s = dur
                silence_s = 0.0
                voiced_rms = [rms]
                quiet_rms = []
                n_interim = 0
                last_interim = time.monotonic()
                await ws.send(json.dumps({"type": "speech"}))
                if nemo is not None:
                    nstream = nemo.create_stream()
                    nlast, nlast_t = "", 0.0
                    ncur, paused = "", False
                    # Đệm thêm im lặng trước đoạn: không có thì Nemotron hay rơi chữ đầu câu
                    # ("Recovers" -> "Covers", "Words is right" -> "Is right"). Đã đo: ≥0,6 s là đủ.
                    lead = np.zeros(int(SAMPLE_RATE * NEMO_LEAD_S), dtype=np.float32)
                    await loop.run_in_executor(None, nemo_feed, nemo, nstream, np.concatenate([lead] + buf))
            continue

        buf.append(chunk)
        if nemo is not None and nstream is not None:
            try:
                txt = await loop.run_in_executor(None, nemo_feed, nemo, nstream, chunk)
            except Exception as e:  # noqa: BLE001
                log(f"WARN nemotron feed failed: {e!r}")
                txt = ""
            if txt:
                ncur = txt
            now_t = time.monotonic()
            if cfg["interim"] and txt and txt != nlast and now_t - nlast_t >= 0.15:
                nlast, nlast_t = txt, now_t
                n_interim += 1
                await ws.send(json.dumps({"type": "interim", "id": uid, "text": txt}))
        if voiced:
            speech_s += dur
            silence_s = 0.0
            voiced_rms.append(rms)
        else:
            silence_s += dur
            quiet_rms.append(rms)
        # Nemotron: báo khoảng lặng ngắn (có thể đã hết câu) để app dịch đoán trước; nói tiếp thì báo "resume".
        if nemo is not None and nstream is not None:
            if voiced and paused:
                paused = False
                await ws.send(json.dumps({"type": "resume", "id": uid}))
            elif (not voiced and not paused and ncur and silence_s >= NEMO_PAUSE_S
                  and silence_s * 1000 < cfg["silence_ms"]):
                paused = True
                # Nemotron trễ ~0,56 s nên chữ cuối chưa ra: đẩy trước một đoạn im lặng (người kia đang im thật) để giải mã
                # nốt, nhờ vậy chữ báo "pause" khớp chữ chốt câu. Nếu họ nói tiếp, đoạn im chèn thêm không làm sai chữ.
                try:
                    flushed = await loop.run_in_executor(
                        None, nemo_feed, nemo, nstream, np.zeros(int(SAMPLE_RATE * 0.6), dtype=np.float32)
                    )
                    if flushed:
                        ncur = flushed
                except Exception as e:  # noqa: BLE001
                    log(f"WARN nemotron flush failed: {e!r}")
                await ws.send(json.dumps({"type": "pause", "id": uid, "text": ncur}))

        soft_cut = total_s() >= SOFT_CUT_S and silence_s >= SOFT_CUT_SILENCE_S
        if silence_s * 1000 >= cfg["silence_ms"]:
            await finalize("silence")
            continue
        if soft_cut:
            await finalize("soft")
            continue
        if total_s() >= MAX_UTTERANCE_S:
            await finalize("max")
            continue

        now = time.monotonic()
        if (
            cfg["interim"]
            and now - last_interim >= INTERIM_EVERY_S
            and (interim_task is None or interim_task.done())
            and speech_s >= MIN_SPEECH_S
            and nemo is None
        ):
            last_interim = now
            n_interim += 1
            interim_task = asyncio.create_task(send_interim(np.concatenate(buf), uid))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--engine", default="whisper", choices=["whisper", "nemotron"])
    ap.add_argument("--nemo-dir", default="", help="thư mục model Nemotron (sherpa-onnx) khi --engine nemotron")
    ap.add_argument("--nemo-threads", type=int, default=4)
    ap.add_argument("--mic-whisper", action="store_true", help="nạp thêm Whisper (GPU) cho kết nối micro khi engine chính là Nemotron")
    ap.add_argument("--compute", default="", help="kiểu tính toán: int8_float16 (mặc định trên GPU), float16, int8")
    args = ap.parse_args()

    model = nemo = None
    if args.engine == "nemotron":
        log(f"Loading Nemotron from {args.nemo_dir} (CPU, {args.nemo_threads} threads)...")
        try:
            nemo = nemo_load(args.nemo_dir, args.nemo_threads)
            nemo_feed(nemo, nemo.create_stream(), np.zeros(SAMPLE_RATE, dtype=np.float32))  # khởi động nóng
        except Exception as e:  # noqa: BLE001
            log(f"ERROR load model: {e}")
            sys.exit(1)
    if args.engine == "whisper" or args.mic_whisper:
        from faster_whisper import WhisperModel

        compute = args.compute or ("int8_float16" if args.device == "cuda" else "int8")
        log(f"Loading model {args.model} on {args.device} ({compute})...")
        try:
            model = WhisperModel(args.model, device=args.device, compute_type=compute)
        except Exception as e:  # noqa: BLE001
            log(f"ERROR load model: {e}")
            sys.exit(1)
        # khởi động nóng
        transcribe(model, np.zeros(SAMPLE_RATE, dtype=np.float32), 1, "")

    async def safe_handle(ws):
        try:
            await handle(ws, model, nemo)
        except websockets.ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            import traceback

            log("WARN handler error:\n" + traceback.format_exc())

    # Kết nối localhost: tắt ping giữ-kết-nối. Khi GPU quá tải tiến trình có thể đứng vài chục giây
    # và bị cắt oan vì "keepalive ping timeout".
    async with websockets.serve(
        safe_handle, "127.0.0.1", args.port, max_size=2**22, ping_interval=None, ping_timeout=None
    ):
        log(f"READY {args.port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
