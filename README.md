# Pocket AI 📱🧠

**A WhatsApp AI assistant that runs 100% on an Android phone.** The WhatsApp connection, the bot logic and the language model (Gemma 3 1B via llama.cpp) all run inside Termux on a realme Narzo 70 Pro. No cloud and no API keys. Messages never leave the phone.

Send it a link and it understands that you want it saved. Ask it something and it chats. Add it to a group and it behaves like Meta AI, but it's yours and it's offline.

```
You:     saw this blog on agents https://lilianweng.github.io/posts/2023-06-23-agent/ for pocket-ai
Pocket:  📌 Saved link (#12)
         Topic: *agents*
         Project: *pocket-ai*

You:     yaad rakhna ki friday ko demo hai
Pocket:  📝 Noted (#7): friday ko demo hai

You:     hinglish me batao, quantization kya hai?
Pocket:  Quantization matlab model ke weights ko chhote numbers me store karna…
```

---

## Highlights

- **Fully on-device.** `llama-server` (llama.cpp, built with `-mcpu=native` for the phone's ARM cores) runs alongside a Node.js WhatsApp client ([Baileys](https://github.com/WhiskeySockets/Baileys), no browser).
- **Two-stage router.** A fast *classify + extract* call with **grammar-constrained JSON** (always valid) decides the intent. Only plain chat goes to a second, free-form generation.
- **Plain code first.** Group triggers, commands, permissions, rate limits, URL extraction and a keyword prefilter don't use the model. About 25% of messages never touch it.
- **"Model proposes, code verifies."** Extracted fields are *grounded*: a project name the user never typed is thrown away.
- **Prompt caching by design.** The classifier prompt prefix is identical for every message and pinned to its own llama.cpp slot. **97.7% of prompt tokens are served from cache**, so each message costs ~18 new tokens instead of ~800.
- **Measured, not guessed.** A command-line eval harness (120 labelled English and Hinglish messages) reports accuracy, F1, field accuracy and p95 latency, and **fails if a change regresses an old task.**
- **Add a feature = add one file.** Tasks (intent + schema + few-shot examples + handler) and commands load automatically.

## Architecture

```mermaid
flowchart LR
  WA[WhatsApp] <--> GW[gateway/whatsapp.js<br/>Baileys]
  GW -->|IncomingMessage| R{core/router.js<br/>decide}
  R -->|ignore| X[ ]
  R -->|/command| C[commands/*.js]
  R -->|ai| Q[single queue<br/>+ typing…]
  Q --> P{prefilter<br/>keywords/URL}
  P -->|no task words| CH[chat reply<br/>slot 1]
  P -->|maybe a task| I[intent call<br/>JSON schema · slot 0]
  I --> G[grounding +<br/>postprocess]
  G -->|save_resource / save_note / …| T[tasks/*.js handler]
  G -->|chat| CH
  T & CH --> DB[(SQLite<br/>node:sqlite)]
  I & CH <--> L[llama-server<br/>Gemma 3 1B Q4_K_M]
```

| Layer | Path | What it does |
|---|---|---|
| Gateway | `src/gateway/whatsapp.js` | The **only** file that knows WhatsApp. Pairing code login, reconnect with backoff, LID→phone mapping, backlog guard, clean logout |
| Router | `src/core/router.js` | Pure `decide()` (ignore / command / deny / ai), then rate limit → queue → intent → task or chat |
| Intent | `src/intent/` | Builds the JSON schema and cached few-shot prompt from the task registry, then grounds the output |
| Tasks | `src/tasks/*.js` | `save_resource`, `save_note`, `chat` (fallback). One file each |
| Commands | `src/commands/*.js` | `/help /ping /reset /stats`, plus commands contributed by tasks (`/res`, `/notes`) |
| LLM | `src/llm/client.js` | llama-server client: `cache_prompt`, `id_slot`, `json_schema`, timings |
| Storage | `src/db/` | Built-in `node:sqlite`, so there is **no native npm module** to compile on Android |

Runtime dependencies: **`baileys` and `pino`**. That's it.

## Evaluation

`npm run eval` runs every message in `eval/datasets/*.jsonl` through the **same detector the bot uses**. The 120 cases are 40 resource, 35 note and 45 "looks like a task but is chat" negatives, tagged English, Hinglish, typo, vague and confusable.

Iterations on **Gemma 3 1B Q4_K_M** (accuracy numbers carry over to the phone; latency below is from the dev Mac, see [phone numbers](#phone-performance)):

| Run | What changed | Intent acc | Field acc | note F1 | resource F1 | chat F1 | resource.project | note.project |
|---|---|---|---|---|---|---|---|---|
| v0 | baseline prompt | 87.5% | 61.0% | 82.5% | 93.7% | 85.7% | 56.4% | 37.1% |
| v1 | grounding + better few-shot (null-project & Hinglish examples) | 90.0% | 77.2% | 87.9% | 93.7% | 88.4% | 71.8% | 80.0% |
| **v2** ✅ | stem-based Hinglish prefilter ("likhna", "bhoolna", "noted") | **91.7%** | **78.7%** | **91.2%** | **93.7%** | **90.3%** | **71.8%** | **80.0%** |
| v3 ✗ | generate `topic` before `project` | 92.5% | 79.4% | 91.2% | 95.0% | 91.3% | **64.1%** | 82.9% |

v3 improved topic (+11) but the regression check flagged project −7.7 points, and project drives how saved items are organised, so **v2 is kept**. Hinglish accuracy went from 72% to 88% between v0 and v2. The classifier outputs ~18 tokens per message, and 97.7% of each prompt is a cache hit. Full table: [`eval/RESULTS.md`](eval/RESULTS.md).

```bash
npm run eval                                         # run + save to eval/results/
npm run eval -- --baseline eval/results/baseline.json  # exit 1 if any task drops > 3 points
npm run eval -- --no-prefilter                       # measure the model alone
./eval/matrix.sh ~/models/*.gguf                     # compare models / quantizations
npm run eval:report -- --write                       # regenerate eval/RESULTS.md
```

## Phone performance

_realme Narzo 70 Pro 5G: MediaTek Dimensity 7050 (2× Cortex-A78 + 6× Cortex-A55), 8 GB RAM, CPU inference._

Fill these in from `./bench/llama-bench.sh` and `npm run eval` on the phone:

| Model | Threads | Prompt tok/s | Gen tok/s | Intent p50 / p95 | RAM |
|---|---|---|---|---|---|
| Gemma 3 1B Q4_K_M | _tbd_ | | | | |
| Gemma 3 1B Q4_0 | _tbd_ | | | | |
| Gemma 3 4B Q4_K_M | _tbd_ | | | | |

`/stats` in WhatsApp shows live numbers: gen and prompt tok/s, avg/p95 latency, cache hit %, free RAM and battery temperature.

## Quick start

**On the Mac (development):**
```bash
brew install llama.cpp
./scripts/download-model.sh 1b
cp .env.example .env        # set BOT_NUMBER, OWNER_NUMBERS
npm install
./scripts/start.sh          # llama-server + bot in tmux
npm run console             # or chat with it in the terminal, no WhatsApp needed
npm test                    # 25 unit tests, no model needed
```

**On the phone:** follow [`docs/PHONE_SETUP.md`](docs/PHONE_SETUP.md). In short: Termux from F-Droid → `git clone` → `./scripts/termux-setup.sh` → `./scripts/start.sh` → enter the pairing code in the cloned WhatsApp (realme App Clone).

## Using it

| Where | How to talk to it |
|---|---|
| Private chat | Just message it (owner + `ALLOWED_NUMBERS`; set `DM_POLICY=all` for everyone) |
| Group | `@Pocket …`, reply to one of its messages, or start with `/ai …` / `hey pocket …`. Otherwise it stays silent. Reply to anyone's message with `@Pocket` and it answers that message |

| Command | |
|---|---|
| `/help` | What it can do |
| `/res [text]` | List or search saved resources |
| `/notes [text]` | List or search notes |
| `/stats` | tok/s, latency, cache hit, RAM, battery temp, uptime |
| `/ping` | Health check |
| `/me` | What it knows about you |
| `/reminders` | Upcoming reminders in this chat (`/reminders cancel <id>`) |
| `/summary` | Group TL;DR of what you missed (or `@Pocket tldr`) |
| `/sticker` | How to make stickers |
| `/claude <question>` | Ask Claude via the Mac bridge (works in groups without tagging) |
| `/code [project:] <task>` | 🔒 Claude Code works on a new branch on the Mac and reports back |
| `/reset` | Forget this chat's history and group context |

**Memory and context.** Each chat keeps its last `HISTORY_TURNS` exchanges. In groups the bot also reads along: when someone addresses it, it sees the group messages since its last reply (`GROUP_CONTEXT_LINES`, default 12), so "@Pocket what do you think?" works. It knows who is talking, and what each person asked it to remember (`remember that …`). Those facts follow you across chats, with one rule: in a DM it sees everything you saved, while in a group it only sees what was saved in that group. All of this stays in SQLite on the phone.

## Stickers, reminders, group summaries

- 🎨 **Sticker maker:** send a photo or GIF with a caption like `sticker`, `sticker with text "Monday mood"` or `round sticker, upar likho chai time in yellow`, or reply to one with `isko sticker bana do`. The model turns the prompt into a spec (text, position, colour, square/circle/rounded), with a plain-code fallback, and ffmpeg renders a 512×512 WebP. **GIFs become animated stickers.** In groups the caption has to start with "sticker", be a reply to a photo asking to make one, or tag the bot.
- ⏰ **Reminders:** `remind me tomorrow 9am to call mom` or `kal shaam 6 baje yaad dilana …`. The model extracts *what* and the *time phrase*, and plain code (`src/util/when.js`) parses English and Hinglish times in `TIMEZONE`, which defaults to the phone's setting. Reminders are stored in SQLite, survive restarts, and @mention the person in groups.
- 📝 **Group summary:** `/summary` or `@Pocket tldr` summarises the messages since *your* last one in that group (up to `SUMMARY_MAX_LINES`), on the phone.

## Voice notes and GIFs

Both are handled on the phone:

- 🎤 **Voice notes:** `ffmpeg` converts the note to 16 kHz WAV, then whisper.cpp (`ggml-base-q5_1`, multilingual, so Hinglish works) transcribes it. The bot answers the transcript and shows what it heard: `🎤 "kal ka plan kya hai"`.
- 🎞️ **GIFs, stickers and photos:** the bot takes one frame and sends it to a small vision model (SmolVLM-500M on a second `llama-server` on port 8081). That model writes a one-line description, and Gemma reacts to it.
- In DMs it always responds. In groups it responds only when the media is a reply to the bot, so a group full of stickers doesn't keep the CPU busy.
- Setup is `scripts/setup-media.sh`. Auto-update runs it once when it changes. Set `MEDIA=off` to turn media handling off.

## Claude on the Mac (`/claude`, `/code`)

The phone forwards these prompts to a small service on the Mac (`bridge/server.js`). The service runs Claude Code (`claude -p`) and the bot posts the answer back into the chat. The phone only makes outgoing requests to the Mac's Tailscale address, so nothing on the phone has to accept connections.

- `/claude …` runs Claude with **no tools**, in an empty folder, so it can't read or change anything on the Mac. Owners can use it anywhere, and anyone can use it in a group, limited to `CLAUDE_PER_HOUR` requests per person.
- `/code …` is **owner only**. Claude works in a new git worktree on a branch `pocket/job-<id>`. It can edit files and run `npm test`, and the bridge commits on that branch. It never pushes and never touches your checkout.
- If the Mac is asleep, requests wait in a queue and are sent when it's back.

Setup: copy `bridge/.env.example` to `bridge/.env`, set a token (`openssl rand -hex 24`), then run `npm run bridge` on the Mac. On the phone, set `MAC_BRIDGE_URL=http://<mac-tailscale-ip>:7777` and the same `BRIDGE_TOKEN` in `.env`.

## Adding a task

Create `src/tasks/<name>.js`, add `eval/datasets/<name>.jsonl`, run the eval with `--baseline`. Nothing else changes.

```js
export default {
  name: 'add_expense',
  description: 'User reports money they spent ("spent 200 on lunch", "auto ka 80 diya").',
  fields: {
    amount: { type: 'number', description: 'amount in rupees' },
    category: { type: ['string', 'null'], description: 'food, travel, … else null' },
  },
  examples: [{ text: 'chai pe 40 gaye', fields: { amount: 40, category: 'food' } }],
  prefilter: (text) => /\d/.test(text),          // optional: skip the model when impossible
  migrate: (db) => db.exec('CREATE TABLE IF NOT EXISTS expenses (...)'),
  async handle(ctx, fields) { /* save */ return `💸 Added ₹${fields.amount}`; },
  commands: [{ name: 'spent', description: 'This month', run: async (ctx) => { /* … */ } }],
};
```

## Configuration

Everything lives in `.env` (see [`.env.example`](.env.example)). The main settings are `BOT_NUMBER`, `OWNER_NUMBERS`, `BOT_NAME`, `MODEL_PATH` (swap models here), `LLM_THREADS`, `LLM_CTX`, `DM_POLICY`, `HISTORY_TURNS`, `GROUP_CONTEXT_LINES`, `RATE_LIMIT_PER_MIN` and `INTENT_PREFILTER`.

## Roadmap

Designed for, not built yet. See [`docs/ROADMAP.md`](docs/ROADMAP.md):
- streaming replies by editing the WhatsApp message as tokens arrive
- Q4_0 vs Q4_K_M and 1B vs 4B comparisons
- fine-tuning Gemma 3 270M/1B on collected examples
- `/mode casual | savage | formal`
- **Mac bridge**: `/fix <project> <issue>` runs Claude Code headless on a new git branch over Tailscale and reports back
- voice notes (whisper.cpp) and images

## ⚠️ Disclaimer

Baileys is an **unofficial** reverse-engineered WhatsApp client. Automating a WhatsApp account breaks WhatsApp's Terms of Service, and **the number can be banned**. Use a dedicated number, don't spam, and don't use this for bulk messaging. This is a personal, educational project, not affiliated with WhatsApp or Meta.

## License

MIT
