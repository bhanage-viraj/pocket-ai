#!/usr/bin/env bash
# Small vision model for GIFs/stickers/photos (llama-server with a multimodal projector) on :8081.
# Started by start.sh in the "vision" tmux window. Waits until setup-media.sh has downloaded it.
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env
M="${VISION_MODEL:-$HOME/models/SmolVLM-500M-Instruct-Q8_0.gguf}"
P="${VISION_MMPROJ:-$HOME/models/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf}"
PORT="${VISION_URL##*:}"; PORT="${PORT%%/*}"; PORT="${PORT:-8081}"
mkdir -p data
# Don't share the chat model's CPU cores: if LLM_EXTRA_ARGS pins chat with "-C <mask>", the vision
# server gets the other cores (e.g. chat 0xC0 = big cores 6,7 -> vision 0x3F). VISION_EXTRA_ARGS overrides.
if [ -z "${VISION_EXTRA_ARGS+x}" ]; then
  VISION_EXTRA_ARGS="${LLM_EXTRA_ARGS:-}"
  if [[ "$VISION_EXTRA_ARGS" =~ -C[[:space:]]+(0x[0-9a-fA-F]+) ]]; then
    mask=${BASH_REMATCH[1]}; all=$(( (1 << $(nproc)) - 1 ))
    VISION_EXTRA_ARGS="${VISION_EXTRA_ARGS/-C $mask/-C $(printf '0x%X' $(( ~mask & all )))}"
  fi
fi
echo "vision server args: ${VISION_EXTRA_ARGS:-(none)}"
while [ ! -s "$M" ] || [ ! -s "$P" ]; do echo "waiting for vision model (scripts/setup-media.sh)…"; sleep 60; done
while true; do
  echo "$(date '+%F %T') starting vision server on :$PORT"
  llama-server -m "$M" --mmproj "$P" --host 127.0.0.1 --port "$PORT" -t "${MEDIA_THREADS:-2}" -c 2048 -np 1 \
    ${VISION_EXTRA_ARGS:-} 2>&1 | tee -a data/vision.log | grep --line-buffered -E "error|listening|failed" || true
  echo "$(date '+%F %T') vision server exited, restarting in 10s"; sleep 10
done
