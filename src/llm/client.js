// Client for llama.cpp's `llama-server` (OpenAI-compatible endpoint + llama.cpp extras).
//
// llama.cpp extras we rely on:
//   cache_prompt  – reuse the KV cache for the shared prompt prefix (system prompt + few-shot)
//   id_slot       – pin a request to a slot so intent and chat prompts don't evict each other
//   response_format.json_schema – grammar-constrained decoding: output is always valid JSON
//   timings       – per-request prompt/generation token counts and speeds

export class LlmError extends Error {}

export function createLlmClient({ url, timeoutMs = 120_000, fetchImpl = fetch } = {}) {
  let modelName = null;

  async function post(pathname, body) {
    const res = await fetchImpl(`${url}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new LlmError(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /**
   * One chat completion.
   * @returns {Promise<{text: string, timings: object, wallMs: number}>}
   */
  async function complete({ messages, maxTokens = 256, temperature = 0.7, jsonSchema, slot, stop }) {
    const body = {
      messages,
      max_tokens: maxTokens,
      temperature,
      cache_prompt: true,
      ...(slot !== undefined && { id_slot: slot }),
      ...(stop && { stop }),
      ...(jsonSchema && { response_format: { type: 'json_schema', json_schema: { schema: jsonSchema } } }),
    };
    const t0 = performance.now();
    const data = await post('/v1/chat/completions', body);
    const wallMs = performance.now() - t0;
    const text = data.choices?.[0]?.message?.content ?? '';
    const t = data.timings || {};
    return {
      text: text.trim(),
      wallMs,
      timings: {
        promptN: t.prompt_n ?? data.usage?.prompt_tokens ?? 0,
        cacheN: t.cache_n ?? 0,
        predictedN: t.predicted_n ?? data.usage?.completion_tokens ?? 0,
        promptMs: t.prompt_ms ?? 0,
        predictedMs: t.predicted_ms ?? 0,
        tokPerSec: t.predicted_per_second ?? 0,
      },
    };
  }

  async function health() {
    try {
      const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Model file name from /props (cached), e.g. "gemma-3-1b-it-Q4_K_M". */
  async function model() {
    if (modelName) return modelName;
    try {
      const res = await fetchImpl(`${url}/props`, { signal: AbortSignal.timeout(3000) });
      const props = await res.json();
      const p = props.model_path || props.default_generation_settings?.model || '';
      modelName = p.split('/').pop().replace(/\.gguf$/, '') || 'unknown';
    } catch {
      return 'unknown';
    }
    return modelName;
  }

  return { complete, health, model, url };
}

/** Slot ids (start llama-server with `-np 2`). */
export const SLOTS = { intent: 0, chat: 1 };
