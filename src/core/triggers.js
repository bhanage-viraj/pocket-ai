// Group trigger logic (pure). The bot speaks in a group only when:
//   - it is @mentioned, or
//   - someone replies to one of its messages, or
//   - the message starts with a text trigger ("/ai", "hey pocket", ...)

/** Returns { triggered, reason, text } where text has the trigger removed. */
export function checkGroupTrigger({ text, mentionsBot, repliesToBot, triggers }) {
  const textTrigger = matchTextTrigger(text, triggers);
  if (textTrigger) return { triggered: true, reason: 'prefix', text: textTrigger.rest };
  if (mentionsBot) return { triggered: true, reason: 'mention', text };
  if (repliesToBot) return { triggered: true, reason: 'reply', text };
  return { triggered: false, reason: 'not-addressed', text };
}

/** "hey Pocket, what's up" -> { trigger: 'hey pocket', rest: "what's up" } */
export function matchTextTrigger(text, triggers) {
  const lower = text.toLowerCase();
  for (const trigger of triggers) {
    if (!lower.startsWith(trigger)) continue;
    const next = lower.charAt(trigger.length);
    // whole-word only: "/aiden" or "hey pocketful" must not trigger
    if (next && /[a-z0-9]/.test(next)) continue;
    return { trigger, rest: text.slice(trigger.length).replace(/^[\s,:!.-]+/, '').trim() };
  }
  return null;
}
