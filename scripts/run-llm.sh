#!/usr/bin/env bash
# Runs llama-server forever (restarts on crash). Started by start.sh inside tmux.
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env

PORT="${LLM_URL##*:}"; PORT="${PORT%%/*}"; PORT="${PORT:-8080}"
THREADS="${LLM_THREADS:-4}"
CTX="${LLM_CTX:-4096}"
SLOTS=2   # slot 0 = intent classifier, slot 1 = chat (separate prompt caches)
mkdir -p data

[ -f "$MODEL_PATH" ] || { echo "Model not found: $MODEL_PATH — run ./scripts/download-model.sh"; exit 1; }

# Gemma 3 uses sliding-window attention: without --swa-full llama.cpp can't reuse a cached prompt
# prefix, so every reply re-reads the whole system prompt + history (~20-30 tokens/s on a phone).
SWA=""
llama-server --help 2>&1 | grep -q -- '--swa-full' && SWA="--swa-full"

while true; do
  echo "$(date '+%F %T') starting llama-server: $(basename "$MODEL_PATH") threads=$THREADS ctx=$CTX x $SLOTS slots"
  llama-server \
    -m "$MODEL_PATH" \
    --host 127.0.0.1 --port "$PORT" \
    -t "$THREADS" -tb "$THREADS" \
    -c $((CTX * SLOTS)) -np "$SLOTS" $SWA \
    ${LLM_EXTRA_ARGS:-} 2>&1 | tee -a data/llm.log | grep --line-buffered -E "error|listening|loaded|failed" || true
  echo "$(date '+%F %T') llama-server exited — restarting in 5s"
  sleep 5
done
