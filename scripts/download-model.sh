#!/usr/bin/env bash
# Download a GGUF model into ~/models.
#   ./scripts/download-model.sh            # default: gemma-3-1b Q4_K_M (~800 MB)
#   ./scripts/download-model.sh 1b-q4_0    # for quantization comparison
#   ./scripts/download-model.sh 4b         # gemma-3-4b Q4_K_M (~2.5 GB)
#   ./scripts/download-model.sh list
set -euo pipefail
DEST="${MODELS_DIR:-$HOME/models}"
mkdir -p "$DEST"

HF=https://huggingface.co
url_for() {
  case "$1" in
    1b)      echo "$HF/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf" ;;
    1b-q4_0) echo "$HF/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_0.gguf" ;;
    1b-q8_0) echo "$HF/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q8_0.gguf" ;;
    4b)      echo "$HF/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf" ;;
    270m)    echo "$HF/unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q4_K_M.gguf" ;;
  esac
}

KEY="${1:-1b}"
if [ "$KEY" = "list" ]; then
  for k in 270m 1b 1b-q4_0 1b-q8_0 4b; do u=$(url_for $k); echo "$k  ${u##*/}"; done
  exit 0
fi
URL=$(url_for "$KEY")
[ -n "$URL" ] || { echo "Unknown model '$KEY'. Try: $0 list"; exit 1; }

FILE="$DEST/${URL##*/}"
if [ -s "$FILE" ]; then echo "Already have $FILE"; exit 0; fi
echo "Downloading ${URL##*/} → $DEST"
curl -L --fail --retry 3 -C - -o "$FILE.part" "$URL"
mv "$FILE.part" "$FILE"
echo "✅ $FILE ($(du -h "$FILE" | cut -f1))"
echo "Set MODEL_PATH=$FILE in .env to use it."
