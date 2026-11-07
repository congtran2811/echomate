# Live Interpreter

App Windows (Electron) nghe âm thanh phát ra từ loa (Meet, Zoom, Teams, Zalo, YouTube, gia sư AI…), hiện từng câu bằng **tiếng Anh + tiếng Việt** và **gợi ý 3 câu trả lời** (tiếng Anh kèm bản dịch). Cửa sổ nhỏ luôn nằm trên cùng nên dùng song song với app gọi điện/trình duyệt.

Hai cách dùng chính:
- **Trò chuyện thật** với người nước ngoài: đọc phụ đề song ngữ, chọn câu trả lời gợi ý để nói.
- **Luyện nói với gia sư** (người hoặc AI): app hiểu kiểu nói của gia sư (sửa câu, “Say it once…”, “Question N”) và gợi ý đúng câu cần nhắc lại.

## Mục lục
- [Tính năng](#tính-năng)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt](#cài-đặt-1-lần)
- [Sử dụng](#sử-dụng)
- [Công cụ nhận dạng giọng nói](#công-cụ-nhận-dạng-giọng-nói)
- [Cài đặt trong app (⚙)](#cài-đặt-trong-app-)
- [Cách hoạt động](#cách-hoạt-động)
- [Chi phí](#chi-phí)
- [Ghi log và phân tích](#ghi-log-và-phân-tích)
- [Đóng gói .exe](#đóng-gói-thành-file-exe)
- [Kiểm thử](#kiểm-thử)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Quyền riêng tư và lưu ý](#quyền-riêng-tư-và-lưu-ý)

## Tính năng
- **Phụ đề song ngữ trực tiếp:** chữ tiếng Anh hiện ngay khi người kia đang nói, bản dịch tiếng Việt hiện ~0,7 s sau khi họ dứt câu.
- **Gợi ý 3 câu trả lời** tự nhiên như người bản xứ: câu 1 luôn trả lời thẳng, câu 2 thường là câu hỏi lại (“How about you?”), câu 3 là hướng khác. Bấm thẻ để copy.
- **Gợi ý xếp chồng theo lượt nói**: bộ mới nhất mở sẵn, bộ cũ thu gọn (tối đa 5), không mất khi người kia nói tiếp.
- **Gợi ý ngay khi nghe xong một câu hỏi** (không chờ thêm để chắc họ đã nói xong).
- **Dịch đoán trước:** khi người kia vừa tạm ngừng, app gửi dịch luôn; câu chốt đúng y chữ thì dùng ngay bản dịch đó.
- **Nghe cả micro của bạn** (tuỳ chọn): lời bạn hiện thành dòng “Tôi” để gợi ý sau bám theo câu bạn đã nói.
- **Hai chế độ:** 🗣 Trò chuyện / 🎓 Gia sư, mỗi chế độ một ô bối cảnh riêng, đổi bằng một cú bấm.
- **Ba công cụ nhận dạng:** Whisper (GPU), Nemotron streaming (CPU, miễn phí), Deepgram Flux (trên mạng, tự biết hết lượt).
- **Chống bịa thông tin:** gợi ý chỉ dùng dữ kiện bạn khai; thiếu thì để chỗ trống `[…]`; có cảnh báo ⚠ khi nghi bịa.
- **Tách người nói** (tuỳ chọn, thử nghiệm) khi âm thanh có nhiều giọng: nhãn A, B, C…
- **Tự bảo vệ:** hết giờ thì bỏ qua thay vì hiện muộn, tự chuyển sang DeepSeek khi GPU nghẽn, tự khởi động lại phần nhận dạng khi bị dừng.
- **Ghi log phiên** (nút 📝) để xem lại độ trễ, chất lượng và chi phí.

## Yêu cầu
| Thành phần | Ghi chú |
|---|---|
| Windows 10/11 | Thu âm thanh hệ thống qua Electron (loopback), không cần driver |
| Node.js 18+ | Chạy app và các script |
| Python 3.10–3.12 | Sidecar nhận dạng giọng nói (venv riêng ở `F:\whisper-stt`) |
| GPU NVIDIA (khuyên ≥ 8 GB) | Cho Whisper và model dịch nháp local. Không có GPU vẫn dùng được Nemotron (CPU) + DeepSeek |
| API key DeepSeek | Dịch và gợi ý chính ([platform.deepseek.com](https://platform.deepseek.com)) |
| Ollama + `gemma3:4b` (tuỳ chọn) | Bản dịch nháp local, dự phòng khi mất mạng |
| API key Deepgram (tuỳ chọn) | Chỉ khi dùng Deepgram Flux |

Máy đang dùng để phát triển: i5-12600KF, RTX 3070 Ti 8 GB.

## Cài đặt (1 lần)
```bash
npm install
npm run setup:whisper                                   # tạo F:\whisper-stt: venv, faster-whisper + thư viện CUDA, model (~3 GB)
powershell -File scripts/setup-whisper.ps1 -Nemotron    # (tuỳ chọn) thêm model Nemotron streaming (~650 MB)
ollama pull gemma3:4b                                   # (tuỳ chọn) model dịch nháp local (~3,3 GB)
```
Đổi thư mục cài: `powershell -File scripts/setup-whisper.ps1 -Dir D:\whisper-stt`, rồi sửa “Thư mục Whisper” trong ⚙.

## Sử dụng
```bash
npm start
```
1. Lần đầu: ⚙ → dán **API key DeepSeek** → Lưu.
2. Đợi chấm trạng thái chuyển xanh (“… sẵn sàng”).
3. Chọn chế độ ở thanh trên: **🗣 Trò chuyện** hoặc **🎓 Gia sư**.
4. Bấm **▶ Bắt đầu nghe**, chọn **Toàn màn hình** trong hộp thoại chia sẻ (chỉ lấy âm thanh hệ thống).
5. Đọc phụ đề, bấm thẻ gợi ý để copy (hoặc đọc to). Bấm **■ Dừng** khi xong.

### Thanh công cụ
| Nút | Chức năng |
|---|---|
| ▶ / ■ | Bắt đầu / dừng nghe |
| 💻 Máy / ☁ Deepgram | Đổi nhanh công cụ nhận dạng: trên máy (miễn phí) ↔ Deepgram (tốn phí) |
| 🗣 Trò chuyện / 🎓 Gia sư | Đổi chế độ (luật dịch và bối cảnh) |
| 📝 | Bật/tắt ghi log phiên |
| 🗑 | Xoá hội thoại và gợi ý |
| 👻 | Click xuyên cửa sổ (`Ctrl+Alt+T`) |
| ⚙ | Cài đặt |

## Công cụ nhận dạng giọng nói
Chọn trong ⚙ → **Công cụ nhận dạng giọng nói**, hoặc nút 💻/☁ trên thanh.

| | Whisper `large-v3-turbo` | Nemotron Streaming 0.6B | Deepgram Flux |
|---|---|---|---|
| Chạy ở | GPU (~1,5 GB VRAM) | CPU (sherpa-onnx) | Trên mạng |
| Chi phí | Miễn phí | Miễn phí | ~0,46 USD/giờ |
| Chữ tạm | Mỗi ~1 s | Liên tục (trễ ~0,55 s/chữ) | Liên tục |
| Chốt câu sau khi im | ~0,2–0,3 s xử lý | ~0,1 s | Tự biết hết lượt (câu hỏi ngắn ~0,2 s, câu dài ~1–2 s) |
| Tên riêng (ô thuật ngữ) | `hotwords` | sửa sau nhận dạng (“Con” → “Kong”) | `keyterm` |
| Hợp với | Giọng của bạn (micro) | Mặc định cho giọng người kia | Cần chữ sạch, nhiều dấu câu |

Số đo trên log thật của dự án (giọng gia sư AI, hội thoại gọi món, voice chat; và giọng người dùng qua micro): trên giọng người dùng, Whisper sai ~14% số từ, Nemotron ~28%, Deepgram ~29%. Vì vậy **micro mặc định chạy Whisper** (⚙ → “Nhận dạng giọng của tôi bằng”), còn giọng người kia chạy Nemotron.

Thử Deepgram trên âm thanh đã ghi (cần bật 📝 + lưu WAV):
```bash
npm run bench:deepgram -- logs/session-XXXX --max 15         # giọng người kia
npm run bench:deepgram -- logs/session-XXXX --mic --max 20   # giọng của bạn (micro)
```

## Cài đặt trong app (⚙)
- **AI dịch / AI gợi ý:** DeepSeek (mặc định) hoặc Ollama local; gợi ý có thể dùng AI riêng.
- **Bản dịch nháp local:** hiện trước bản nháp từ `gemma3:4b` khi chưa có bản dịch đoán trước.
- **Độ dài gợi ý** (ngắn / vừa / dài), **mức tiếng Anh** (*Đơn giản*: từ dễ nhưng cách nói tự nhiên, có viết tắt; *Tự nhiên*: như người bản xứ), **phong cách**.
- **Vai trò & thông tin về bạn:** chỉ ghi dữ kiện thật (nghề, nơi làm, sở thích, thành tích…). Gợi ý chỉ dùng những dữ kiện này.
- **Chế độ** + **bối cảnh** cho từng chế độ (VD trò chuyện: “Phỏng vấn lập trình viên”; gia sư: “Buổi luyện nói với gia sư AI…”).
- **Tên riêng / thuật ngữ** (cách nhau dấu phẩy): giúp nhận dạng và dịch đúng tên.
- **Nghe cả micro của tôi** + công cụ cho micro. Nên dùng **tai nghe**.
- **Tách người nói** (nhãn A, B, C…; bấm nhãn để đánh dấu “đây là tôi”) và ngưỡng nhận ra cùng một người.
- **Im lặng bao lâu thì chốt câu** (mặc định 500 ms), **hết lượt** (1000 ms), **ngưỡng âm thanh**, **độ trong suốt**.
- **Khi ghi log: lưu cả âm thanh (WAV)**.

API key DeepSeek/Deepgram được lưu **mã hoá** trong máy (Electron `safeStorage`), không ghi vào log.

## Cách hoạt động
```
Âm thanh loa ──► AudioWorklet (PCM 16 kHz) ──► main (Electron) ──► sidecar Python (Whisper / Nemotron)  ─┐
Micro (tuỳ chọn) ──────────────────────────► main ──► kết nối riêng tới sidecar (Whisper)               ├─► câu chốt
                                                └──► hoặc Deepgram Flux (WebSocket)                      ─┘
câu chốt ──► DeepSeek dịch (kèm bản nháp local / bản đoán trước) ──► phụ đề tiếng Việt
lượt nói ──► DeepSeek gợi ý (streaming, 3 câu) ──► thẻ gợi ý
```
- **Đoạn:** chốt sau ~0,5 s im lặng. Nói liền quá 12 s thì cắt ở chỗ ngừng ngắn đầu tiên, tối đa 25 s.
- **Lượt nói:** các đoạn liên tiếp của người kia. Gợi ý chạy khi hết lượt (im thêm ~0,5 s), **ngay lập tức** nếu đoạn vừa chốt là một câu hỏi trọn vẹn, hoặc khi Deepgram báo hết lượt. Lượt quá dài (>25 s) thì gợi ý giữa chừng.
- **Dịch nháp tiến trình:** đoạn nhiều câu thì các câu đã nói xong được dịch nháp trong lúc người kia còn nói.
- **Dịch đoán trước:** Nemotron báo khi im ~0,25 s, Deepgram báo `EagerEndOfTurn`; khớp chữ khi chốt thì dùng luôn (đo thật: khớp gần như 100%, bản dịch hiện sớm hơn ~0,25 s và không bị thay chữ).
- **Lời của bạn (micro)** được ghi vào ngữ cảnh dạng `Me: …`. Đoạn micro trùng ≥50% chữ với câu người kia vừa nói trong 2 s trước bị coi là tiếng vọng (loa ngoài) và bỏ.
- **Lọc:** cụm ảo giác từ tiếng ồn nhỏ (“Thank you.”), đoạn không phải tiếng Anh (hiện mờ, không dịch), gợi ý lặp lại câu của họ.
- **Prompt:** phần cố định đặt trước để DeepSeek dùng cache (đo thật: 56–85% token đầu vào trúng cache).

## Chi phí
- **DeepSeek:** đo trên log thật ~0,08–0,22 USD/giờ (dịch + gợi ý, đã tính cache). Giá giờ cao điểm (01–04 và 06–10 UTC, thứ Hai–thứ Sáu) gấp đôi.
- **Deepgram Flux:** 0,0077 USD/phút (~0,46 USD/giờ) theo bảng giá Deepgram, chỉ tính khi đang nghe.
- **Whisper, Nemotron, Ollama:** miễn phí (chạy trên máy).

Giá có thể thay đổi; kiểm tra trên trang của DeepSeek và Deepgram.

## Ghi log và phân tích
Bấm **📝** để bắt đầu ghi (nút đổi màu, banner báo thư mục), bấm lại để dừng. Mỗi phiên là một thư mục `session-YYYYMMDD-HHMMSS\` trong:
- `<thư mục dự án>\logs` khi chạy `npm start`;
- `%APPDATA%\live-interpreter\logs` khi chạy bản `.exe` (đổi bằng `logDir` trong `settings.json`).

Nội dung:
- `events.jsonl`: câu nhận dạng (thời gian xử lý, âm lượng, lý do cắt), bản dịch, gợi ý (thời gian, token, cache), dịch đoán trước, câu của bạn qua micro, mẫu VRAM, lỗi.
- `audio\*.wav` và `audio\mic\*.wav`: âm thanh từng đoạn nếu bật “lưu cả âm thanh”.

```bash
node scripts/analyze-log.js            # tóm tắt phiên mới nhất
node scripts/analyze-log.js logs/session-XXXX --details   # kèm từng câu EN/VI và gợi ý
```

## Đóng gói thành file .exe
```bash
npm run build
```
Chạy `npm test` trước, rồi đóng gói vào `dist\Live Interpreter-win32-x64\` (~180 MB). Mở `Live Interpreter.exe` là chạy.
- Gói chỉ chứa phần Electron. **Sidecar Python vẫn cần cài riêng** (`npm run setup:whisper`, script có trong gói) và **Ollama** nếu dùng model local.
- Bản `.exe` và bản `npm start` dùng chung cài đặt và API key (`%APPDATA%\live-interpreter`). App chỉ cho chạy **một bản** một lúc; hãy đóng app trước khi build lại.

## Kiểm thử
```bash
npm test          # logic (phân tích gợi ý, lọc, nhận diện câu hỏi, Deepgram, log…) + giao diện (DOM giả lập)
npm run test:py   # sidecar: nhận dạng người nói
```

## Xử lý sự cố
| Hiện tượng | Cách xử lý |
|---|---|
| “… chưa sẵn sàng” khi bấm nghe | Xem dòng trạng thái góc trên; chạy lại `npm run setup:whisper`; kiểm tra đường dẫn model trong ⚙ |
| Không hiện chữ | Giảm “Ngưỡng âm thanh”; kiểm tra đã chọn **Toàn màn hình** khi chia sẻ |
| Câu bị cắt vụn | Tăng “Im lặng bao lâu thì chốt câu” |
| Bản dịch để nguyên tiếng Anh / chú thích kiểu gia sư khi trò chuyện thật | Chọn chế độ **🗣 Trò chuyện** |
| Micro ghi lại giọng người kia | Dùng tai nghe |
| Chậm bất thường, banner VRAM | Tắt app nặng GPU khác; app tự chuyển sang DeepSeek 5 phút |
| Deepgram báo “sai API key” / “hết tiền” | Nhập lại key trong ⚙ hoặc nạp tiền; bấm 💻 để quay về công cụ trên máy |
| Tên riêng bị nghe sai | Thêm vào “Tên riêng / thuật ngữ” |

## Cấu trúc dự án
```
src/main/        main.js (cửa sổ, thu âm, lượt nói, dịch/gợi ý), llm.js (prompt, DeepSeek/Ollama),
                 deepgram.js (Flux), settings.js, lang.js (lọc, sửa chữ, nhận diện câu hỏi), sessionlog.js, gpu.js
src/preload/     cầu nối IPC
src/renderer/    giao diện (index.html, renderer.js, style.css, worklet.js thu PCM)
stt-server/      sidecar Python: server.py (Whisper/Nemotron, VAD, chữ tạm), speakers.py (tách người nói)
scripts/         setup-whisper.ps1, build.js, selftest.js, uitest.js, analyze-log.js, bench-deepgram.js
```
Sidecar được cài/chép sang `F:\whisper-stt` (venv, model, `server.py`). Sau khi sửa `stt-server/`, chạy lại `npm run setup:whisper` hoặc chép `server.py`/`speakers.py` sang đó.

## Quyền riêng tư và lưu ý
- **Chỉ dùng khi bạn có quyền nghe/ghi âm cuộc trò chuyện** (nhiều nơi yêu cầu báo cho người tham gia).
- Văn bản câu nói (không phải âm thanh) được gửi lên DeepSeek để dịch và gợi ý. Chọn **Deepgram** thì **âm thanh** được gửi lên Deepgram. Dùng Whisper/Nemotron + Ollama cho mọi phần thì không có gì rời khỏi máy.
- **Log chứa nội dung hội thoại và có thể cả ghi âm**: mặc định tắt mỗi lần mở app, thư mục `logs/` không đưa lên git (`.gitignore`). Xoá khi không cần.
- VRAM 8 GB khá sát: Whisper + `gemma3:4b` + app khác dùng chung GPU. Model 7–8B chạy được nhưng dễ nghẽn; Qwen hay lẫn chữ Hán khi dịch tiếng Việt.
- DeepSeek đổi tên model theo thời gian; app thử lần lượt `deepseek-flash`, `deepseek-v4-flash`, `deepseek-chat`.
