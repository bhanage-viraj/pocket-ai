// WhatsApp gateway (Baileys). The only file that knows about WhatsApp.
// It turns raw Baileys messages into plain `IncomingMessage` objects for the router,
// and exposes a tiny I/O surface: reply, setTyping, sendText, editText.
import fs from 'node:fs';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidDecode,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys';
import { log } from '../util/log.js';

/**
 * @typedef {object} IncomingMessage
 * @property {string} id
 * @property {string} chatId
 * @property {boolean} isGroup
 * @property {string} text          message text with the bot's @mention removed
 * @property {number} timestamp     unix seconds
 * @property {{jid: string, number: string|null, name: string}} sender
 * @property {boolean} mentionsBot
 * @property {boolean} repliesToBot
 * @property {object} raw           original Baileys message (for quoting)
 * @property {{kind: 'voice'|'gif'|'sticker'|'image', seconds: number, download: () => Promise<Buffer>}|null} media
 */

const EXIT_LOGGED_OUT = 3;

export function createWhatsAppGateway({ config, onMessage }) {
  const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
  let sock = null;
  let selfIds = [];
  let reconnectAttempts = 0;
  let pairingRequested = false;

  // Recently handled message ids, so a message delivered twice is answered once.
  const seenIds = new Set();
  const seen = (id) => {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value);
    return false;
  };

  const isSelf = (jid) => !!jid && selfIds.some((id) => areJidsSameUser(id, jid));

  /** Like isSelf, but also maps an unknown @lid to its phone-number JID first (mentions in groups use LIDs). */
  async function isSelfAsync(current, jid) {
    if (!jid) return false;
    if (isSelf(jid)) return true;
    if (!jid.endsWith('@lid')) return false;
    const pn = await current.signalRepository?.lidMapping?.getPNForLID?.(jid).catch(() => null);
    if (pn && isSelf(pn)) {
      selfIds.push(jid); // remember our LID for next time
      return true;
    }
    return false;
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));

    sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, // keep the owner's phone notifications working
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    const current = sock;

    current.ev.on('creds.update', saveCreds);
    current.ev.on('connection.update', (u) => onConnectionUpdate(current, u));
    current.ev.on('messages.upsert', ({ messages, type }) => {
      log.debug(`upsert type=${type} n=${messages.length}`);
      // 'notify' = live. 'append' = our own sends from other devices AND messages that arrived while
      // we were offline (delivered on reconnect). Both go through normalize(): fromMe is skipped
      // there, and old ones are flagged stale (late reply if addressed, else context only).
      if (type !== 'notify' && type !== 'append') return;
      for (const raw of messages) {
        if (seen(raw.key?.id)) continue; // the same message can arrive as append and notify
        normalize(current, raw)
          .then((msg) => msg && onMessage(msg))
          .catch((err) => log.error('message handling failed:', err.message));
      }
    });
  }

  async function onConnectionUpdate(current, { connection, lastDisconnect, qr }) {
    if (current !== sock) return; // stale socket

    if (qr && !current.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      if (!config.botNumber) {
        log.error('BOT_NUMBER is not set in .env — needed to request a pairing code.');
        process.exit(1);
      }
      try {
        const code = await current.requestPairingCode(config.botNumber);
        const pretty = code?.match(/.{1,4}/g)?.join('-') ?? code;
        console.log(
          `\n┌──────────────────────────────────────────────┐\n` +
            `│  PAIRING CODE:  ${pretty.padEnd(29)}│\n` +
            `└──────────────────────────────────────────────┘\n` +
            `Cloned WhatsApp (bot number) → ⋮ → Linked devices → Link a device\n` +
            `→ "Link with phone number instead" → enter the code.\n`,
        );
      } catch (err) {
        log.error('Could not get a pairing code:', err.message);
        pairingRequested = false;
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      pairingRequested = false;
      const me = current.authState?.creds?.me;
      selfIds = [...new Set([current.user?.id, current.user?.lid, me?.id, me?.lid].filter(Boolean))];
      log.debug(`self ids: ${selfIds.map((j) => j.split('@')[1]).join(', ')}`);
      log.info(`✅ WhatsApp connected as ${jidDecode(current.user?.id)?.user}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error('🚪 Logged out from WhatsApp (device unlinked). Clearing session; restart to pair again.');
        fs.rmSync(config.authDir, { recursive: true, force: true });
        process.exit(EXIT_LOGGED_OUT);
      }
      const delay =
        code === DisconnectReason.restartRequired ? 0 : Math.min(15_000, 2000 * 2 ** reconnectAttempts++); // short cap: recover fast after a network blip
      log.warn(`🔌 WhatsApp connection closed (${code ?? 'unknown'}); reconnecting in ${delay / 1000}s`);
      setTimeout(() => connect().catch((e) => log.error('reconnect failed:', e.message)), delay);
    }
  }

  /** Resolve a sender to a phone number, using the LID<->PN mapping when WhatsApp hides the number. */
  async function senderNumber(current, jid, altJid) {
    for (const j of [altJid, jid]) {
      if (j && j.endsWith('@s.whatsapp.net')) return jidDecode(j)?.user ?? null;
    }
    const lid = [jid, altJid].find((j) => j?.endsWith('@lid'));
    if (lid) {
      const pn = await current.signalRepository?.lidMapping?.getPNForLID?.(lid).catch(() => null);
      if (pn) return jidDecode(pn)?.user ?? null;
    }
    return null;
  }

  /** Voice notes, GIFs, stickers and photos -> a lazy descriptor (nothing is downloaded yet). */
  function mediaOf(current, raw, content) {
    const kind = content.audioMessage ? 'voice'
      : content.videoMessage?.gifPlayback ? 'gif'
      : content.stickerMessage ? 'sticker'
      : content.imageMessage ? 'image'
      : null;
    if (!kind) return null;
    const m = content.audioMessage || content.videoMessage || content.stickerMessage || content.imageMessage;
    return {
      kind,
      seconds: Number(m.seconds || 0),
      mimetype: m.mimetype || '',
      download: () =>
        downloadMediaMessage(raw, 'buffer', {}, { logger: baileysLogger, reuploadRequest: current.updateMediaMessage }),
    };
  }

  /** Baileys message -> IncomingMessage (or null to skip). */
  async function normalize(current, raw) {
    const { key } = raw;
    const chatId = key?.remoteJid;
    const skip = (why) => (log.debug(`skip ${key?.id ?? '?'}: ${why}`), null);
    if (!chatId || key.fromMe) return skip(key?.fromMe ? 'fromMe' : 'no chat');
    if (isJidStatusBroadcast(chatId) || isJidBroadcast(chatId) || isJidNewsletter(chatId)) return skip('broadcast');

    // Backlog guard: after a reconnect WhatsApp delivers queued messages; ignore stale ones.
    // Stale ones are still returned (flagged) so they end up in the group context, but get no reply.
    const timestamp = Number(raw.messageTimestamp || 0);
    const stale = !!timestamp && Date.now() / 1000 - timestamp > config.maxMessageAgeS;

    const content = normalizeMessageContent(raw.message);
    if (!content) return skip(`no content (stub=${raw.messageStubType ?? '-'} ${raw.messageStubParameters?.[0] ?? ''})`);
    let text =
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      '';
    const media = mediaOf(current, raw, content);
    if (!text.trim() && !media) return skip(`no text (${Object.keys(content).join(',')})`);

    const contextInfo = Object.values(content).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
    const mentioned = contextInfo?.mentionedJid || [];
    let mentionsBot = false;
    for (const j of mentioned) if (await isSelfAsync(current, j)) { mentionsBot = true; break; }
    const repliesToBot = await isSelfAsync(current, contextInfo?.participant);
    const q = contextInfo?.quotedMessage ? normalizeMessageContent(contextInfo.quotedMessage) : null;
    const quotedText = (q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || '').trim();
    const quoted = quotedText && !repliesToBot ? { text: quotedText, id: contextInfo.stanzaId ?? null } : null;
    if (mentioned.length) log.debug(`mentions: ${mentioned.map((j) => j.split('@')[1]).join(', ')} -> bot=${mentionsBot}`);

    // remove "@<bot>" tokens from the text
    for (const id of selfIds) {
      const user = jidDecode(id)?.user;
      if (user) text = text.replaceAll(`@${user}`, ' ');
    }

    const isGroup = !!isJidGroup(chatId);
    const jid = isGroup ? key.participant : chatId;
    const altJid = isGroup ? key.participantAlt : key.remoteJidAlt;
    const number = await senderNumber(current, jid, altJid);

    return {
      id: key.id,
      chatId,
      isGroup,
      text: text.replace(/\s+/g, ' ').trim(),
      timestamp,
      sender: { jid, number, name: raw.pushName || number || 'Someone' },
      mentionsBot,
      repliesToBot,
      quoted, // { text, id } when this message replies to someone else's message
      media, // voice note / GIF / sticker / photo; downloaded only if the router decides to answer
      stale,
      raw,
    };
  }

  const io = {
    async reply(msg, text) {
      return sock.sendMessage(msg.chatId, { text }, { quoted: msg.raw });
    },
    async sendText(chatId, text) {
      return sock.sendMessage(chatId, { text });
    },
    /** Edit a message the bot sent (used for streaming replies later). */
    async editText(chatId, key, text) {
      return sock.sendMessage(chatId, { text, edit: key });
    },
    async setTyping(chatId, on) {
      await sock?.sendPresenceUpdate(on ? 'composing' : 'paused', chatId).catch(() => {});
    },
  };

  return { connect, io };
}
