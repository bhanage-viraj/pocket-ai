#!/usr/bin/env bash
# Compare models / quantizations: starts a temporary llama-server per GGUF, runs the eval, stops it.
#   ./eval/matrix.sh ~/models/gemma-3-1b-it-Q4_K_M.gguf ~/models/gemma-3-1b-it-Q4_0.gguf ~/models/gemma-3-4b-it-Q4_K_M.gguf
# Env: THREADS (default from .env LLM_THREADS or 4), PORT (default 8091)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env

PORT=${PORT:-8091}
THREADS=${THREADS:-${LLM_THREADS:-4}}
[ $# -gt 0 ] || { echo "usage: $0 model1.gguf [model2.gguf ...]"; exit 1; }

for MODEL in "$@"; do
  MODEL=$(expand_home "$MODEL")
  NAME=$(basename "$MODEL" .gguf)
  echo "=== $NAME (threads $THREADS) ==="
  llama-server -m "$MODEL" --host 127.0.0.1 --port "$PORT" -c 8192 -np 2 -t "$THREADS" > "data/matrix-$NAME.log" 2>&1 &
  PID=$!
  trap 'kill $PID 2>/dev/null || true' EXIT
  wait_for_llm "http://127.0.0.1:$PORT" 180 || { echo "server failed, see data/matrix-$NAME.log"; kill $PID; continue; }
  node --disable-warning=ExperimentalWarning eval/run.js --url "http://127.0.0.1:$PORT" --label "$NAME-t$THREADS" --quiet || true
  kill $PID; wait $PID 2>/dev/null || true
done
node eval/report.js
