#!/usr/bin/env bash
# Start Pocket AI in a tmux session: "llm" (llama-server), "bot" (WhatsApp), "update" (pulls from GitHub).
#   ./scripts/start.sh          start (or say it's already running)
#   tmux attach -t pocket       watch it  (Ctrl+b then n = next window, Ctrl+b then d = detach)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
SESSION=pocket

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock   # keep CPU awake with screen off

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Pocket AI is already running. Attach with: tmux attach -t $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -n llm "bash scripts/run-llm.sh"
tmux new-window -t "$SESSION" -n bot "bash scripts/run-bot.sh"
tmux new-window -t "$SESSION" -n update "bash scripts/auto-update.sh"
echo "✅ Pocket AI started in tmux session '$SESSION'."
echo "   Watch:  tmux attach -t $SESSION      Stop: ./scripts/stop.sh"
