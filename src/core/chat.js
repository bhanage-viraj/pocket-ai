// Stage 2: free-form chat reply with per-chat history.
import { SLOTS } from '../llm/client.js';
import { chatSystemPrompt } from '../llm/prompts.js';
import { toWhatsApp } from '../util/text.js';

export function createChat({ llm, memory, config, onGeneration = () => {} }) {
  return {
    /**
     * userContent is already prefixed with [Name] in groups. `context` (people, recent group
     * messages) goes into the LAST user message only, not the system prompt, so the cached
     * prefix (system + history) stays the same and llama-server can reuse it.
     */
    async reply({ chatId, isGroup, userContent, context = '' }) {
      const last = context ? `(Context, use it if relevant, don't repeat it)\n${context}\n\n${userContent}` : userContent;
      const messages = [
        { role: 'system', content: chatSystemPrompt({ isGroup }) },
        ...memory.history(chatId),
        { role: 'user', content: last },
      ];
      const result = await llm.complete({
        messages,
        maxTokens: config.chatMaxTokens,
        temperature: config.chatTemperature,
        slot: SLOTS.chat,
      });
      onGeneration('chat', result);
      // strip a "[Name]:" the model sometimes copies from group history
      return toWhatsApp(result.text.replace(/^\s*\[[^\]]{1,40}\]:?\s*/, ''));
    },
  };
}
