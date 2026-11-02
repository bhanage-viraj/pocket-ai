# Shared helpers for the shell scripts. Source it: `source scripts/lib.sh`
POCKET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

expand_home() { local p="$1"; echo "${p/#\~/$HOME}"; }

# Load .env (KEY=VALUE lines) without overriding variables already set in the environment.
load_env() {
  local f="$POCKET_DIR/.env"
  [ -f "$f" ] && while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# || -z "${line// }" ]] && continue
    local key="${line%%=*}" val="${line#*=}"
    key="${key// /}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [ -z "${!key+x}" ] && export "$key=$val"
  done < "$f"
  MODEL_PATH=$(expand_home "${MODEL_PATH:-~/models/gemma-3-1b-it-Q4_K_M.gguf}")
  export MODEL_PATH
}

wait_for_llm() { # url timeout_s
  local url="$1" t="${2:-120}"
  for _ in $(seq 1 "$t"); do
    curl -sf "$url/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

is_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; }
