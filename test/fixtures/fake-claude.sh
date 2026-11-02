#!/usr/bin/env bash
# Stand-in for `claude -p` in tests: echoes the prompt; in a git worktree it also writes a file.
prompt="$2"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "$prompt" > CHANGED_BY_CLAUDE.txt; fi
tools=""; for a in "$@"; do [ "$prev" = "--tools" ] && tools="$a"; prev="$a"; done
printf '{"type":"result","is_error":false,"result":"answer to: %s (tools=%s)","total_cost_usd":0.01}\n' "$prompt" "${tools:-none}"
