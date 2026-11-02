#!/usr/bin/env bash
# Stand-in for whisper-cli: "transcribes" by printing the wav file's contents.
f=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && f="$a"; prev="$a"; done
echo " [BLANK_AUDIO] $(cat "$f")"
