// Stage 2: free-form chat reply with per-chat history.
import { SLOTS } from '../llm/client.js';
import { chatSystemPrompt } from '../llm/prompts.js';
import { toWhatsApp } from '../util/text.js';

export function createChat({ llm, memory, config, onGeneration = () => {} }) {
  return {
    /** userContent is already prefixed with [Name] in groups. */
    async reply({ chatId, isGroup, userContent }) {
      const messages = [
        { role: 'system', content: chatSystemPrompt({ isGroup }) },
        ...memory.history(chatId),
        { role: 'user', content: userContent },
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
