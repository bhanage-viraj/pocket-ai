#!/usr/bin/env bash
# Auto-update: every UPDATE_INTERVAL_S, fast-forward to the latest commit on GitHub and restart
# only what changed. Runs in the "update" tmux window (started by start.sh).
# Push from the Mac -> the phone picks it up within a few minutes. UPDATE_INTERVAL_S=0 turns it off.
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env
INTERVAL="${UPDATE_INTERVAL_S:-300}"
if [ "$INTERVAL" = 0 ]; then echo "Auto-update is off (UPDATE_INTERVAL_S=0)."; exec sleep infinity; fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "$(date '+%F %T') auto-update: checking origin/$BRANCH every ${INTERVAL}s"

while true; do
  sleep "$INTERVAL"
  git fetch -q origin "$BRANCH" 2>/dev/null || continue          # offline: try again later
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] && continue
  if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
    echo "$(date '+%F %T') local commits differ from GitHub; not updating (fix with git status)"; continue
  fi
  CHANGED=$(git diff --name-only HEAD "origin/$BRANCH")
  git merge -q --ff-only "origin/$BRANCH" || { echo "merge failed (local edits?)"; continue; }
  echo "$(date '+%F %T') updated to: $(git log --oneline -1)"

  if grep -qE '^package(-lock)?\.json$' <<<"$CHANGED"; then
    echo "  installing dependencies"; npm ci --omit=dev 2>/dev/null || npm install --omit=dev
  fi
  if grep -qE '^scripts/(run-llm|lib)\.sh$' <<<"$CHANGED"; then
    echo "  restarting llama-server"; tmux respawn-window -k -t pocket:llm "bash scripts/run-llm.sh"
  fi
  if grep -qE '^(src/|package|scripts/(run-bot|lib)\.sh)' <<<"$CHANGED"; then
    echo "  restarting bot"; tmux respawn-window -k -t pocket:bot "bash scripts/run-bot.sh"
  fi
  if grep -qE '^scripts/auto-update\.sh$' <<<"$CHANGED"; then
    echo "  reloading updater"; exec bash scripts/auto-update.sh
  fi
done
