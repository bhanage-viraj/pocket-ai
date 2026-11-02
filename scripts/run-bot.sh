#!/usr/bin/env bash
# Runs the WhatsApp bot forever (restarts on crash). Started by start.sh inside tmux.
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env
mkdir -p data

echo "Waiting for llama-server at ${LLM_URL:-http://127.0.0.1:8080}…"
wait_for_llm "${LLM_URL:-http://127.0.0.1:8080}" 300 || echo "llama-server not up yet; starting bot anyway"

DELAY=5
while true; do
  START=$(date +%s)
  node --disable-warning=ExperimentalWarning src/index.js 2>&1 | tee -a data/bot.log
  CODE=${PIPESTATUS[0]}
  # exponential backoff if it keeps crashing quickly; reset after a healthy run
  if [ $(( $(date +%s) - START )) -gt 300 ]; then DELAY=5; else DELAY=$(( DELAY * 2 > 300 ? 300 : DELAY * 2 )); fi
  [ "$CODE" = 3 ] && echo ">>> Logged out of WhatsApp. A new pairing code will be shown on restart."
  echo "$(date '+%F %T') bot exited ($CODE) — restarting in ${DELAY}s"
  sleep "$DELAY"
done
