# Cài Whisper (faster-whisper) vào ổ F: để không tốn dung lượng ổ C.
param(
  [string]$Dir = "F:\whisper-stt",
  [string]$Model = "large-v3-turbo",
  [switch]$Nemotron  # tải thêm model Nemotron streaming (~460 MB tải, ~650 MB giải nén) để dùng thử
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Split-Path $Dir -Qualifier))) { throw "Không thấy ổ $(Split-Path $Dir -Qualifier)" }
New-Item -ItemType Directory -Force $Dir | Out-Null
New-Item -ItemType Directory -Force "$Dir\models" | Out-Null

if (-not (Test-Path "$Dir\venv\Scripts\python.exe")) {
  Write-Host "Tạo venv..."
  python -m venv "$Dir\venv"
}
$py = "$Dir\venv\Scripts\python.exe"

Write-Host "Cài gói (faster-whisper + CUDA libs, ~2-3 GB)..."
& $py -m pip install --upgrade pip
& $py -m pip install -r "$root\stt-server\requirements.txt"

Copy-Item "$root\stt-server\server.py" "$Dir\server.py" -Force
Copy-Item "$root\stt-server\speakers.py" "$Dir\speakers.py" -Force

# Model nhận dạng giọng (tách người nói, ~40 MB). Đã thử 4 model trên giọng người thật và giọng tổng hợp:
# chỉ titanet tách đúng, các model wespeaker/3dspeaker cho kết quả lộn xộn.
$spkDir = "$Dir\models\speaker"
New-Item -ItemType Directory -Force $spkDir | Out-Null
$spkModel = "$spkDir\nemo_en_titanet_small.onnx"
if (-not (Test-Path $spkModel)) {
  Write-Host "Tải model nhận dạng giọng (titanet, ~40 MB)..."
  Invoke-WebRequest -UseBasicParsing "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx" -OutFile $spkModel
}

Write-Host "Tải model $Model về $Dir\models ..."
$env:HF_HOME = "$Dir\models"
& $py -c "from faster_whisper import WhisperModel; WhisperModel('$Model', device='cpu', compute_type='int8'); print('model OK')"

if ($Nemotron) {
  $nm = "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25"
  $nd = "$Dir\nemotron"
  New-Item -ItemType Directory -Force $nd | Out-Null
  if (-not (Test-Path "$nd\$nm\encoder.int8.onnx")) {
    Write-Host "Tải model Nemotron streaming..."
    $tar = "$nd\$nm.tar.bz2"
    Invoke-WebRequest -UseBasicParsing "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$nm.tar.bz2" -OutFile $tar
    tar -xjf $tar -C $nd
    Remove-Item $tar
  }
  Write-Host "Nemotron: $nd\$nm  (chọn trong Cài đặt > Công cụ nhận dạng giọng nói)"
}

Write-Host "Xong. Whisper đã cài ở $Dir"
