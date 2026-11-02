#!/usr/bin/env bash
# One-time setup for voice notes + GIFs (idempotent; auto-update runs it after pulling this file).
#   ffmpeg            pkg
#   whisper.cpp       built from source for this CPU -> whisper-cli
#   ggml-base-q5_1    speech-to-text model (~60 MB, multilingual: English, Hindi, Hinglish)
#   SmolVLM-500M      small vision model + projector (~550 MB) for GIFs/stickers/photos
set -euo pipefail
REF="${WHISPER_REF:-v1.9.5}"
SRC="${WHISPER_SRC:-$HOME/whisper.cpp}"
JOBS="${JOBS:-2}"   # gentle: the bot keeps running while this builds
DEST="${MODELS_DIR:-$HOME/models}"
HF=https://huggingface.co
mkdir -p "$DEST"

echo "==> ffmpeg"
command -v ffmpeg >/dev/null || pkg install -y ffmpeg

echo "==> whisper.cpp $REF"
if ! command -v whisper-cli >/dev/null; then
  [ -d "$SRC/.git" ] || git clone --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$SRC"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF
  nice -n 10 cmake --build "$SRC/build" --config Release -j "$JOBS" --target whisper-cli
  ln -sf "$SRC/build/bin/whisper-cli" "${PREFIX:-/usr/local}/bin/whisper-cli"
fi

get() { # url
  local f="$DEST/${1##*/}"
  [ -s "$f" ] && return 0
  echo "  downloading ${1##*/}"
  curl -L --fail --retry 3 -C - -o "$f.part" "$1" && mv "$f.part" "$f"
}
echo "==> models"
get "$HF/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
get "$HF/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf"
get "$HF/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf"
echo "✅ Media ready: voice notes + GIFs/stickers/photos"
