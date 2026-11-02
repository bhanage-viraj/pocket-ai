#!/data/data/com.termux/files/usr/bin/bash
# One-time setup inside Termux. See docs/PHONE_SETUP.md for the full guide.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing packages"
pkg update -y
pkg install -y nodejs git tmux curl openssh termux-api cmake clang make

echo "==> Installing Node dependencies"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

echo "==> Building llama.cpp for this CPU (takes ~10-20 min)"
./scripts/build-llama.sh

echo "==> Downloading the default model"
./scripts/download-model.sh 1b

[ -f .env ] || { cp .env.example .env; echo "==> Created .env"; }

echo "==> Termux:Boot autostart"
mkdir -p ~/.termux/boot
sed "s#__POCKET_DIR__#$(pwd)#" scripts/boot/pocket-ai > ~/.termux/boot/pocket-ai
chmod +x ~/.termux/boot/pocket-ai scripts/*.sh

cat <<MSG

✅ Setup done. Next:
  1. nano .env          → set BOT_NUMBER, OWNER_NUMBERS (and BOT_NAME)
  2. ./scripts/start.sh
  3. tmux attach -t pocket → switch to the 'bot' window (Ctrl+b n) to see the pairing code
MSG
