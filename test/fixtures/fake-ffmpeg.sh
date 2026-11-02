#!/usr/bin/env bash
# Stand-in for ffmpeg: copies the -i input to the last argument (the output file).
in=""; prev=""; for a in "$@"; do [ "$prev" = "-i" ] && in="$a"; prev="$a"; done
out="${@: -1}"
cp "$in" "$out"
