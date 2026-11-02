#!/usr/bin/env bash
# Thread-count benchmark with llama-bench.
# The Dimensity 7050 has 2 big (Cortex-A78) + 6 little (Cortex-A55) cores. More threads is NOT
# always faster: little cores can hold back the big ones. This finds the best LLM_THREADS.
#
#   ./bench/llama-bench.sh                      # model from .env
#   ./bench/llama-bench.sh ~/models/gemma-3-4b-it-Q4_K_M.gguf
#   THREADS=2,4,6 REPS=5 ./bench/llama-bench.sh
#
# Writes bench/results/<date>_<model>.md
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
load_env

MODEL=$(expand_home "${1:-$MODEL_PATH}")
NCPU=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu)
THREADS="${THREADS:-$(seq -s, 1 "$NCPU" | sed 's/,3,/,/;s/,5,/,/;s/,7,/,/')}"   # 1,2,4,6,8 on 8 cores
REPS="${REPS:-3}"
PROMPT="${PROMPT_TOKENS:-128}"
GEN="${GEN_TOKENS:-64}"
NAME=$(basename "$MODEL" .gguf)
OUT="bench/results/$(date +%F_%H%M)_${NAME}.md"
mkdir -p bench/results

# Big cores = highest max frequency (Linux/Android sysfs). Build a hex mask for --cpu-mask.
BIG_MASK=""; BIG_COUNT=0
if [ -r /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq ]; then
  MAX=0
  for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq; do v=$(cat "$f"); [ "$v" -gt "$MAX" ] && MAX=$v; done
  MASK=0
  for d in /sys/devices/system/cpu/cpu[0-9]*; do
    i=${d##*cpu}; v=$(cat "$d/cpufreq/cpuinfo_max_freq")
    if [ "$v" -eq "$MAX" ]; then MASK=$(( MASK | (1 << i) )); BIG_COUNT=$((BIG_COUNT + 1)); fi
  done
  BIG_MASK=$(printf '0x%X' "$MASK")
fi

temp() { command -v termux-battery-status >/dev/null && termux-battery-status | grep -o '"temperature": [0-9.]*' | cut -d' ' -f2 || echo "n/a"; }
SOC=$(getprop ro.soc.model 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)

{
  echo "# llama-bench: $NAME"
  echo
  echo "- Device: $SOC · $NCPU cores · big-core mask ${BIG_MASK:-n/a} ($BIG_COUNT cores)"
  echo "- llama.cpp: $(llama-bench --version 2>&1 | grep -m1 version || echo '?')"
  echo "- pp = prompt processing ($PROMPT tok), tg = generation ($GEN tok), $REPS reps · battery temp at start: $(temp)°C"
  echo
  echo "## Thread sweep"
  echo
} | tee "$OUT"

llama-bench -m "$MODEL" -t "$THREADS" -p "$PROMPT" -n "$GEN" -r "$REPS" -o md | tee -a "$OUT"

if [ -n "$BIG_MASK" ] && [ "$BIG_COUNT" -gt 0 ]; then
  echo "Cooling down 30s…"; sleep 30
  { echo; echo "## Pinned to big cores only (--cpu-mask $BIG_MASK --cpu-strict 1)"; echo; } | tee -a "$OUT"
  llama-bench -m "$MODEL" -t "$BIG_COUNT" -C "$BIG_MASK" --cpu-strict 1 -p "$PROMPT" -n "$GEN" -r "$REPS" -o md | tee -a "$OUT"
fi

{ echo; echo "Battery temp at end: $(temp)°C"; } | tee -a "$OUT"
echo
echo "Saved $OUT — set LLM_THREADS in .env to the fastest tg row."
