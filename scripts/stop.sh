#!/usr/bin/env bash
tmux kill-session -t pocket 2>/dev/null && echo "Stopped." || echo "Not running."
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
