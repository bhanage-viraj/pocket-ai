#!/usr/bin/env bash
# Build llama.cpp (llama-server + llama-bench) from source, tuned for THIS CPU (-mcpu=native).
# On the Dimensity 7050 that enables ARMv8.2 dotprod kernels, which the generic package may not use.
#   ./scripts/build-llama.sh            # pinned release
#   LLAMA_REF=master ./scripts/build-llama.sh
set -euo pipefail
REF="${LLAMA_REF:-v0.8.0}"
SRC="${LLAMA_SRC:-$HOME/llama.cpp}"
JOBS="${JOBS:-4}"   # 4 parallel compile jobs keeps an 8 GB phone from running out of RAM

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "refs/tags/$REF:refs/tags/$REF" 2>/dev/null || git -C "$SRC" fetch --depth 1 origin "$REF"
  git -C "$SRC" checkout -q "$REF" 2>/dev/null || git -C "$SRC" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$REF" https://github.com/ggml-org/llama.cpp "$SRC"
fi

cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=ON \
  -DLLAMA_CURL=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF
cmake --build "$SRC/build" --config Release -j "$JOBS" --target llama-server llama-bench llama-cli

BIN="${PREFIX:-/usr/local}/bin"
for t in llama-server llama-bench llama-cli; do ln -sf "$SRC/build/bin/$t" "$BIN/$t"; done
echo "✅ Built llama.cpp $REF → $BIN/llama-server"
llama-server --version 2>&1 | tail -2
