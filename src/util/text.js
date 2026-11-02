const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** All http(s) URLs in a message, trailing punctuation trimmed. */
export function extractUrls(text) {
  return (String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ''));
}

export const stripUrls = (text) => String(text).replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();

/** Normalize a project name for matching: "Pocket AI" == "pocket-ai" == "pocket_ai". */
export const normalizeKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Convert common Markdown that small models emit into WhatsApp formatting.
 * WhatsApp: *bold*, _italic_, ~strike~, ```mono```, no headings/tables.
 */
export function toWhatsApp(md) {
  let s = String(md ?? '').replace(/\r\n/g, '\n');
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '*$1*'); // headings -> bold line
  s = s.replace(/\*\*(.+?)\*\*/g, '*$1*'); // **bold** -> *bold*
  s = s.replace(/__(.+?)__/g, '_$1_'); // __x__ -> _x_
  s = s.replace(/~~(.+?)~~/g, '~$1~'); // ~~x~~ -> ~x~
  s = s.replace(/^\s*[-*]\s+/gm, '• '); // bullets
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)'); // [t](url)
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
