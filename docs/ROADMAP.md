# Roadmap & designs

Each item says where it plugs into the current code, so none of them needs a core rewrite.

## Speed

### Streaming replies (edit-as-you-go)
- `llm/client.js`: add `stream({ ..., onDelta })` using `stream: true` (SSE). `timings` arrive in the final chunk.
- `gateway/whatsapp.js` already exposes `io.editText(chatId, key, text)` (Baileys `{ text, edit: key }`).
- `core/chat.js`: send a first message after ~20 tokens, then edit it **at most every ~1.5 s**. WhatsApp rate-limits edits, and every edit is a network round trip. A final edit sends the complete text.
- Measure **time-to-first-message** in `generations` (add a `ttft_ms` column) and show it in `/stats`.

### Quantization and model comparisons
`./scripts/download-model.sh 1b-q4_0 1b-q8_0 4b`, then `./eval/matrix.sh ~/models/*.gguf` on the phone. That gives one table with accuracy, latency and tok/s per model. Also run `./bench/llama-bench.sh` per model. Q4_0 can be faster on ARM because of repacked kernels.

### Fine-tuning Gemma 3 270M / 1B
1. **Collect.** Log every intent decision to an `intent_log` table (text, predicted JSON, final outcome). Add `/wrong` (owner-only): "the last classification was wrong" plus the correct intent.
2. **Export** to JSONL in the same format as `eval/datasets`. Keep the eval set **held out**.
3. **Train** a LoRA on the Mac (MLX-LM or Unsloth), merge, convert to GGUF, then quantize.
4. **Compare** with `eval/matrix.sh`. A fine-tuned 270M might match 1B accuracy at about 3× the speed and could drop the few-shot block entirely.

## Personality: `/mode casual | savage | formal`
- Add a `chat_settings(chat_id, mode)` table and a `/mode` command file.
- `llm/prompts.js`: `chatSystemPrompt({ isGroup, mode })` adds one short style line per mode, keeping the prefix stable per chat for caching.
- Guardrail line in every mode: casual swearing is fine in casual/savage, but **never** slurs or attacks on religion, caste, gender, looks or similar.
- Add `eval/datasets/tone.jsonl` and a tiny judge script to spot-check that savage mode stays within the rules.

## Mac bridge: `/fix <project> <issue>`

```
Phone (owner only)                     Mac (Tailscale, 100.x.y.z)
/fix pocket-ai "queue timeout bug"
 → jobs table (status=queued)
 → POST https://mac:7777/jobs  ───────▶ mac-bridge (tiny Node HTTP service)
   Authorization: Bearer <token>         ├─ project must be in ALLOWLIST (name → path)
                                         ├─ git worktree add ../wt-<id> -b pocket/fix-<id> origin/main
                                         ├─ claude -p "<issue>" --output-format json
                                         │    --allowedTools "Read,Edit,Bash(npm test:*),Bash(git diff:*)"
                                         │    --permission-mode acceptEdits   (no push, no network tools)
                                         ├─ git commit on the branch; NEVER push to main
                                         │   (optionally push the branch only)
                                         └─ POST result → phone /bridge/callback
 ◀─ summary + branch name + diff stat ──
WhatsApp: "✅ pocket/fix-17 ready: 3 files, tests pass"
```

- **Phone side:** a `fix` command (owner-only) plus a `jobs` table (`id, project, issue, status, branch, summary, created_at`). A retry loop runs every 60 s. If the Mac is unreachable (asleep), the job stays `queued` and the bot replies *"Mac is asleep, queued #17. I'll run it when it wakes."*
- **Callback:** the bot polls `GET /jobs/:id` while jobs are pending. That's simpler than exposing a port on the phone, and it works over Tailscale.
- **Safety:** project allowlist, a token in both `.env` files, a new branch every time, a git worktree so your working copy is untouched, a tool allowlist, a timeout, and one job at a time.

## Media
- **Voice notes:** `whisper.cpp` built in Termux (`base` or `small` multilingual). The gateway downloads the audio (`downloadMediaMessage`), converts it with ffmpeg to 16 kHz WAV, transcribes it, then feeds the text to the router as if typed. Reply `🎙️ "<transcript>"` first.
- **Images:** Gemma 3 4B with its `mmproj` file in llama-server (multimodal). The image caption plus the image go to the chat model only when the bot is addressed.

## More tasks (one file each)
`set_reminder` (needs a scheduler loop plus a `reminders` table, and time parsing in code with the model only extracting the phrase), `add_expense`, `todo_done`, `summarize_group` (last N group messages, needs opt-in message logging).
