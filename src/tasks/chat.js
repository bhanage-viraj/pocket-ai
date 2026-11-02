// Fallback intent: normal conversation. No handler — the router sends it to the chat model.
// Its examples are the important "looks like a task but is just chat" negatives.
export default {
  name: 'chat',
  description:
    'Anything else: questions, explanations, greetings, banter, opinions, help requests. ' +
    'Also links shared just to talk about them, or questions about a link ("what is this?"). When unsure, choose chat.',
  examples: [
    { text: 'what is RAG and how is it different from fine tuning?' },
    { text: 'bhai ye link dekh, kya bakwaas hai lol https://youtu.be/abc123' },
    { text: 'can you remember my birthday?' },
    { text: 'kal ka plan kya hai? kuch idea do weekend ke liye' },
    { text: 'what is this about? https://example.com/some-post' },
  ],
};
