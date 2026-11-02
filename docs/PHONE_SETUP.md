# Phone setup guide (realme Narzo 70 Pro 5G)

This takes about 45 minutes, mostly waiting for the llama.cpp build. Do the steps in order.

---

## 0. Before you start
- The phone is charging and on Wi-Fi.
- A **cloned WhatsApp** is set up with the bot SIM. Your personal WhatsApp stays separate.
  - On realme UI: **Settings → Apps → App Clone → WhatsApp** → turn it on. A second WhatsApp icon (with a small clone badge) appears on the home screen.
  - Open the clone, register it with the bot SIM's number, and finish setup (name, photo).
- The code is pushed to GitHub from the Mac (see the end of this guide).

## 1. Install the apps (from F-Droid, not the Play Store)
The Play Store builds of Termux are old and broken. Install **F-Droid** from <https://f-droid.org>, then install from it:
1. **Termux**
2. **Termux:API**
3. **Termux:Boot**

Open **Termux:Boot** once and close it. That registers it to run at boot.

## 2. Stop Android from killing Termux (realme UI / ColorOS)
realme is aggressive about background apps. Do **all** of these, or the bot will die after a few minutes with the screen off.

**a. App battery settings.** Settings → Apps → App management → **Termux** → Battery usage:
- Allow background activity: **ON**
- Allow auto launch / Allow auto-start: **ON**
- Allow foreground activity: **ON** (if shown)

Repeat for **Termux:Boot** and **Termux:API**.

**b. Battery optimisation.** Settings → Battery → More settings → **Optimise battery use** → All apps → Termux → **Don't optimise**.
In the same screen, turn **off**: *Sleep standby optimisation*, *Auto-optimise* and *Smart power saving*, where shown.

**c. Lock Termux in Recents.** Open Recents (swipe up and hold) → tap the ⋮ / down arrow on the Termux card → **Lock**. A small padlock appears.

**d. Child-process killer (important for llama-server).** Android 12+ kills "phantom" child processes that use a lot of CPU.
- Android 14 or newer: Settings → About device → Version → tap **Build number** 7 times to unlock Developer options. Then Settings → Additional settings → **Developer options** → turn on **Disable child process restrictions**.
- If that toggle doesn't exist, run these once from a computer with `adb`:
  ```
  adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
  adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
  adb shell settings put global settings_enable_monitor_phantom_procs false
  ```

**e. Battery health while always plugged in.** Settings → Battery → More settings → turn on **Optimised / Smart charging**, so the battery isn't held at 100% all day.

**f. Wakelock.** The start script calls `termux-wake-lock`. The Termux notification will say *"wake lock held"*. Leave that notification alone.

## 3. Get the code
Open Termux:
```bash
termux-setup-storage          # allow storage (tap Allow)
pkg update -y && pkg install -y git
git clone https://github.com/<your-username>/pocket-ai.git
cd pocket-ai
```

## 4. Run the setup script
```bash
./scripts/termux-setup.sh
```
This installs Node, tmux, cmake and clang, then **builds llama.cpp for your CPU** (about 10–20 min; the phone gets warm, which is normal). Then it downloads Gemma 3 1B (~800 MB) and installs the boot script.

## 5. Configure
```bash
nano .env
```
Set these (Ctrl+O, Enter to save, Ctrl+X to exit):
```
BOT_NUMBER=62xxxxxxxxxx      # bot SIM: country code, no +, no leading 0
OWNER_NUMBERS=91xxxxxxxxxx   # your personal number
BOT_NAME=Pocket
```

## 6. Find the best thread count (5 min)
```bash
./bench/llama-bench.sh
```
Find the `tg64` row with the highest t/s and set `LLM_THREADS` in `.env` to that thread count. On the 7050, 2 big cores often beat 8 mixed cores for generation. The result is saved in `bench/results/`, so commit it for the README.

## 7. Start and link WhatsApp
```bash
./scripts/start.sh
tmux attach -t pocket
```
Press **Ctrl+b** then **n** to switch to the `bot` window. After a few seconds it prints:
```
PAIRING CODE:  ABCD-EFGH
```
Now open the **cloned WhatsApp** (the icon with the clone badge, logged in as the bot number) → ⋮ → **Linked devices** → **Link a device** → **Link with phone number instead** → type the code.

When the window shows `✅ WhatsApp connected`, press **Ctrl+b** then **d** to detach. It keeps running.

## 8. Test it
From **your personal WhatsApp**:
1. Send `hi` to the bot number. You should get a reply.
2. Send `/stats`.
3. Send `saw this blog https://example.com for pocket-ai` → 📌 Saved, then `/res`.
4. Create a group with the bot. Send `hello` (silence), then `@Pocket hello` (reply).

## 9. Test auto-start
Reboot the phone. Don't open anything. After about a minute, message the bot. It should answer. If it doesn't, see Troubleshooting.

---

## Daily use
| Want to… | Run in Termux |
|---|---|
| See logs live | `tmux attach -t pocket` (Ctrl+b n to switch, Ctrl+b d to leave) |
| Stop | `./scripts/stop.sh` |
| Start | `./scripts/start.sh` |
| Update code | `git pull && npm install && ./scripts/stop.sh && ./scripts/start.sh` |
| Run evals on the phone | `npm run eval -- --label phone-1b-t2` |
| Try another model | `./scripts/download-model.sh 4b`, set `MODEL_PATH` in `.env`, restart |

**Open the cloned WhatsApp on the phone at least once every ~14 days**, or WhatsApp unlinks the bot.

## Optional: SSH from the Mac
In Termux: `pkg install openssh && passwd && sshd`. Find the phone's IP with `ifconfig wlan0`.
From the Mac: `ssh -p 8022 <phone-ip>`. The boot script starts `sshd` automatically.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Bot stops when the screen is off | Redo step 2 (a–d), and check the Termux notification says "wake lock held" |
| `[Process completed (signal 9)]` | Phantom process killer: step 2d |
| No pairing code | Check `BOT_NUMBER` in `.env` (country code, no `+`, no leading 0) |
| "Logged out" in logs | The device was unlinked. Restart and you'll get a new pairing code |
| `😴 My brain is offline` reply | llama-server crashed. Check the `llm` window or `data/llm.log`. Often RAM: close apps, or lower `LLM_CTX` |
| Very slow replies | Run the bench (step 6). Check `/stats` battery temp; above ~42 °C the CPU throttles |
| `npm install` fails on `sharp` | `.npmrc` already disables it. Run `npm install --legacy-peer-deps` |

---

## Mac → GitHub → phone
On the Mac, once:
```bash
cd ~/Desktop/whatsapp
git init && git add -A && git commit -m "Pocket AI"
gh repo create pocket-ai --public --source . --push
```
After that: Mac `git push`, phone `git pull`. `.env`, `auth/` and `data/` are gitignored, so your numbers and WhatsApp session never go to GitHub.
