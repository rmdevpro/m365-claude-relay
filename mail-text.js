// read-mail-text (Infra #96): mail messages as text with the bulk junk removed.
//
// Rule: remove obvious junk, never cut or rewrite the message itself. Bodies come
// from Softeria's own mail tools as plain text (its default body format); then
// cleanText() removes runs of invisible padding characters, image placeholders (a
// bracketed address of an image file), and quoted reply history from its header
// down (earlier messages pasted below a reply; forwards keep theirs); anything
// ambiguous is kept. Links are kept: links wrapped by mail
// security or webmail (Safe Links, Proofpoint URL Defense, Google's redirect) are
// unwrapped to the real address and tracking parameters (utm_* and the like) are
// dropped; only an address still longer than 300 characters, a tracking redirect,
// is shortened to ⟦link: domain⟧. Line endings become \n, and ⟦ ⟧ in the body
// itself appear as [ ] (the marker brackets are reserved). Signatures, footers,
// whitespace and everything else in the message are left as they are.
//
// Mail bodies are attacker-controlled: every pattern is bounded and linear, the
// cleaner reads at most MAX_INPUT_CHARS per message (beyond that the message is
// marked truncated), and a link marker cannot be forged from body text (the
// marker brackets are neutralised in the input). Nothing is cut silently: text
// is complete unless maxChars (default 3,000) or the input cap applied
// (truncated: true), and a response over the limit is refused whole with advice
// to narrow the query.

const MAX_IDS = 20;
const MAX_TOP = 20;
const MAX_INPUT_CHARS = 300_000;
// Each message's text is cut here unless the caller asks for more. On a real mailbox
// (649 messages) the median cleaned message is about 1,000 characters and the worst
// page of 20 at this cap about 68,000, inside the response limit with room for long
// recipient lists. Ticket systems that repeat their history in every update put the
// newest entry first, so the cut keeps it.
const DEFAULT_MAX_CHARS = 3_000;
const SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,body';

const TOOL_NAME = 'read-mail-text';
const TOOL_DEF = {
  name: TOOL_NAME,
  title: 'Read mail as clean text',
  description:
    'Read up to 20 mail messages as text with the bulk junk removed: invisible padding, image placeholders and ' +
    'quoted reply history (forwards keep theirs). Links are kept: Safe Links, Proofpoint and Google redirects are ' +
    'unwrapped to the real address and tracking parameters (utm_* and similar) dropped; only an address still over ' +
    '300 characters (a tracking redirect) is shortened to ⟦link: domain⟧. Everything else (signatures, footers, ' +
    'whitespace) is left as the message has it; line endings become \\n and ⟦ ⟧ in the body itself appear as [ ]. ' +
    'Use get-mail-message for the raw body or the quoted thread. Give ' +
    'messageIds, or folderId with optional top and filter or search (newest first). ' +
    'Each message is cut to maxChars characters (default 3,000; marked truncated: true): pass a larger maxChars, up to ' +
    '300,000, for the whole of a long message; a body over 300,000 characters is cleaned only that far. If the whole result would ' +
    'be too large the call fails, naming the largest messages: narrow it with fewer messages, a filter, or maxChars.',
  inputSchema: {
    type: 'object',
    properties: {
      messageIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_IDS, description: `Message ids to read (max ${MAX_IDS}). Give messageIds or folderId, not both.` },
      folderId: { type: 'string', description: 'Folder to read from: a well-known name (inbox, sentitems, drafts, archive, deleteditems, junkemail) or a folder id.' },
      top: { type: 'integer', minimum: 1, maximum: MAX_TOP, description: `With folderId: how many messages, newest first (default and max ${MAX_TOP}).` },
      filter: { type: 'string', description: "With folderId: OData $filter, e.g. receivedDateTime ge 2026-10-01T00:00:00Z or from/emailAddress/address eq 'a@b.com'." },
      search: { type: 'string', description: 'With folderId: KQL search, e.g. from:paul subject:"quarterly report". Cannot be combined with filter.' },
      maxChars: { type: 'integer', minimum: 1, maximum: MAX_INPUT_CHARS, description: 'Cut each message text to this many characters (marked truncated). Default 3,000; pass up to 300,000 for the whole of a long message (a body over 300,000 characters is cleaned only that far, also marked truncated).' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Read mail as clean text', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

class ToolError extends Error {}

// ---- cleaning ---------------------------------------------------------------

const MARK_OPEN = '⟦'; // ⟦
const MARK_CLOSE = '⟧'; // ⟧
const mark = (host) => `${MARK_OPEN}link: ${host}${MARK_CLOSE}`;
// Addresses still longer than this after unwrapping and dropping tracking
// parameters are shortened to the domain. Nearly all are tracking redirects; the
// exact address of any link is in get-mail-message.
const MAX_KEPT_URL = 300;
// Query parameters that only identify the recipient or campaign to a tracker:
// ones defined by analytics and ad platforms, valid on any site, and LinkedIn's
// own, only on LinkedIn links.
const TRACKING_PARAM = /^(utm_[a-z_]+|mc_cid|mc_eid|_hsenc|_hsmi|__hstc|__hssc|__hsfp|mkt_tok|gclid|dclid|fbclid|msclkid|yclid|igshid)$/i;
const LINKEDIN_TRACKING_PARAM = /^(trackingid|refid|lipi|midtoken|midsig|trk|trkemail)$/i;

// Reply headers. The "On <date>, <name> wrote:" forms must contain a digit (the
// date), so text that merely mentions the phrase is not taken for one.
const QUOTE_START = [
  /^On .{1,300}wrote:\s*$/i,                              // Gmail/Apple: On <date>, <name> wrote:
  /^-{2,}\s*Original Message\s*-{2,}/i,                   // Outlook classic
  /^Le .{1,300}a écrit\s*:\s*$/i, /^Am .{1,300}schrieb .{0,200}:\s*$/i,
];
const DATED = [true, false, true, true];
const isReplyHeader = (l) => QUOTE_START.some((r, k) => r.test(l) && (!DATED[k] || /\d/.test(l)));
const HEADER_FROM = /^\*?From:\*?\s+\S/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject):\*?\s/i;
const SEPARATOR = /^_{10,}\s*$/; // Outlook's line above a From:/Sent: block

// "From: ..." followed by at least two of Sent/Date/To/Subject: a quoted message's header block.
function isHeaderBlock(lines, i) {
  const l = (lines[i] || '').trim();
  if (l.length > 2000 || !HEADER_FROM.test(l)) return false;
  let k = 0;
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) if (lines[j].length < 2000 && HEADER_NEXT.test(lines[j].trim())) k++;
  return k >= 2;
}

function quoteStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.length > 2000) continue; // header lines are short; skip giant lines cheaply
    if (isReplyHeader(l)) return i;
    // Apple Mail quotes the whole history with ">", header included.
    if (l.startsWith('>') && isReplyHeader(l.replace(/^(?:>[ \t]?){1,20}/, '').trim())) return i;
    // "On Tue, 1 Oct 2026 at 10:00, Paul\n<paul@x.com> wrote:" split over two lines
    if (/^On .{1,200}/i.test(l) && /\d/.test(l) && i + 1 < lines.length && l.length + lines[i + 1].length < 320 && /wrote:\s*$/i.test(lines[i + 1].trim())) return i;
    if (isHeaderBlock(lines, i)) return i;
    // The separator counts only above a header block: ticket systems and
    // receipts use the same line between parts of the message itself.
    if (SEPARATOR.test(l)) {
      let j = i + 1;
      while (j < lines.length && j <= i + 2 && !lines[j].trim()) j++;
      if (isHeaderBlock(lines, j)) return i;
    }
  }
  return -1;
}

// Proofpoint URL Defense v3: the real address sits between "__" markers, with
// some characters replaced by "*" (one) or "**<c>" (a run) and listed, base64
// encoded, after the ";".
const RUN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function unwrapUrlDefenseV3(u) {
  const m = /^https:\/\/urldefense\.com\/v3\/__(.{1,4096}?)__;([A-Za-z0-9_-]{0,4096})!/.exec(u);
  if (!m) return undefined;
  const replaced = [...Buffer.from(m[2], 'base64url').toString('utf8')];
  let next = 0;
  let out = m[1].replace(/\*\*(.)|\*/g, (tok, run) => {
    const n = run === undefined ? 1 : RUN_CHARS.indexOf(run) + 2;
    if (n < 1) return tok;
    const r = replaced.slice(next, next + n).join('');
    next += n;
    return r;
  });
  out = out.replace(/^(https?:)\/(?!\/)/i, '$1//');
  return new URL(out).href;
}

// One wrapper removed, or undefined when the link is not wrapped.
function unwrapOnce(u) {
  const url = new URL(u);
  const host = url.hostname.toLowerCase();
  if (/(^|\.)safelinks\.protection\.outlook\.com$/.test(host)) {
    const w = url.searchParams.get('url');
    return w ? new URL(w).href : undefined;
  }
  if (host === 'urldefense.com') return unwrapUrlDefenseV3(u);
  if (host === 'urldefense.proofpoint.com') {
    // v2: "-" stands for "%" and "_" for "/" in the encoded address.
    const w = url.searchParams.get('u');
    return w ? new URL(decodeURIComponent(w.replace(/_/g, '/').replace(/-/g, '%'))).href : undefined;
  }
  if (/^(www\.)?google\.[a-z.]{2,6}$/.test(host) && url.pathname === '/url') {
    const w = url.searchParams.get('q') ?? url.searchParams.get('url');
    return w && /^https?:\/\//i.test(w) ? new URL(w).href : undefined;
  }
  return undefined;
}

// The real address behind a link. Mail security and webmail wrap links in their
// own redirect (Outlook/Defender Safe Links, Proofpoint URL Defense, Google's
// /url redirect), sometimes one inside another. Tracking parameters are then dropped.
function unwrap(u) {
  let real = u;
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = unwrapOnce(real); } catch { next = undefined; }
    if (!next || next === real) break;
    real = next;
  }
  try {
    const r = new URL(real);
    const linkedIn = /(^|\.)linkedin\.com$/i.test(r.hostname);
    let dropped = false;
    for (const k of [...r.searchParams.keys()]) if (TRACKING_PARAM.test(k) || (linkedIn && LINKEDIN_TRACKING_PARAM.test(k))) { r.searchParams.delete(k); dropped = true; }
    return dropped ? r.href : real;
  } catch { return real; }
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '') || 'link'; } catch { return 'link'; }
}
// A link as it appears in the output: the real address in full when short,
// otherwise a marker naming the real host.
function showLink(u) {
  const real = unwrap(u);
  return real.length <= MAX_KEPT_URL ? real : mark(hostOf(real));
}

// A bare URL ends before whitespace, quotes, angle or square brackets; trailing
// sentence punctuation and an unbalanced closing parenthesis are not part of it.
function splitUrlTail(u) {
  let end = u.length;
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < u.length; i++) { if (u[i] === '(') opens++; else if (u[i] === ')') closes++; }
  while (end > 0) {
    const c = u[end - 1];
    if ('.,;:!?'.includes(c)) { end--; continue; }
    if (c === ')' && closes > opens) { end--; closes--; continue; }
    break;
  }
  return [u.slice(0, end), u.slice(end)];
}

function isImageUrl(u) {
  try { return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(new URL(u).pathname); } catch { return false; }
}

function cleanLinks(t) {
  // Graph's text conversion writes anchors as "label<https://...>"; bare URLs also
  // occur. Every quantifier is bounded and the delimiters are excluded from the
  // runs, so a hostile body stays linear.
  t = t.replace(/<((?:https?|mailto|tel):[^<>\s]{1,4096})>/gi, (m, u) => {
    if (/^(mailto|tel):/i.test(u)) return m;
    const shown = showLink(u);
    return shown.startsWith(MARK_OPEN) ? shown : `<${shown}>`;
  });
  t = t.replace(/(^|[^<])\b(https?:\/\/[^\s<>"'[\]⟦⟧]{1,4096})/gi, (m, pre, raw) => {
    const [u, tail] = splitUrlTail(raw);
    return pre + showLink(u) + tail;
  });
  return t;
}

// "[<image url>]": Graph's text for an image is its address in brackets. Only an
// address that names an image file is removed, nothing around it; other bracketed
// links stay.
const IMAGE_PLACEHOLDER = /\[[ \t]{0,20}(https?:\/\/[^\s<>"'[\]⟦⟧]{1,4096})[ \t]{0,20}\]/gi;

function cleanText(raw, opts = {}) {
  const t = String(raw || '')
    .replace(/\r\n?/g, '\n') // line endings
    // Preheader padding: runs of invisible characters (a single one, such as a soft
    // hyphen in a word, is part of the text and stays).
    .replace(/(?:(?:[\u200b-\u200d\u2060\ufeff\u00ad]|\u034f)[ \t\u00a0\u2007\u202f]*){3,}/g, ' ')
    .replace(/⟦/g, '[').replace(/⟧/g, ']'); // the marker brackets are reserved: body text cannot make a marker
  let lines = t.split('\n');
  if (!opts.keepQuoted) {
    const q = quoteStart(lines);
    if (q >= 0 && lines.slice(0, q).join('').trim()) {
      // The text up to the header, exactly: its last line break included.
      lines = lines.slice(0, q).concat('');
    }
  }
  // Everything else, whitespace included, is left as the message has it.
  return cleanLinks(lines.join('\n').replace(IMAGE_PLACEHOLDER, (m, u) => (isImageUrl(u) ? '' : m)));
}

// ---- requests and output ----------------------------------------------------

function validate(args) {
  const a = args === undefined ? {} : args;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ToolError('arguments must be an object');
  const known = new Set(Object.keys(TOOL_DEF.inputSchema.properties));
  for (const k of Object.keys(a)) if (!known.has(k)) throw new ToolError(`unknown argument "${k}"`);
  const hasIds = a.messageIds !== undefined;
  const hasFolder = a.folderId !== undefined;
  if (hasIds === hasFolder) throw new ToolError('give messageIds or folderId (exactly one)');
  if (a.maxChars !== undefined && !(Number.isInteger(a.maxChars) && a.maxChars > 0 && a.maxChars <= MAX_INPUT_CHARS)) throw new ToolError(`maxChars must be an integer from 1 to ${MAX_INPUT_CHARS}`);
  if (hasIds) {
    if (!Array.isArray(a.messageIds) || !a.messageIds.length || a.messageIds.some((x) => typeof x !== 'string' || !x.trim())) throw new ToolError('messageIds must be a non-empty list of ids');
    if (a.messageIds.length > MAX_IDS) throw new ToolError(`at most ${MAX_IDS} messageIds per call`);
    if (a.top !== undefined || a.filter !== undefined || a.search !== undefined) throw new ToolError('top, filter and search apply only with folderId');
  } else {
    if (typeof a.folderId !== 'string' || !a.folderId.trim()) throw new ToolError('folderId must be a non-empty string');
    if (a.top !== undefined && !(Number.isInteger(a.top) && a.top >= 1 && a.top <= MAX_TOP)) throw new ToolError(`top must be 1..${MAX_TOP}`);
    for (const k of ['filter', 'search']) {
      if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k].trim())) throw new ToolError(`${k} must be a non-empty string (omit it to read the newest messages)`);
    }
    if (a.filter !== undefined && a.search !== undefined) throw new ToolError('Graph cannot combine filter and search; use one');
  }
  return a;
}

function addr(r) {
  const e = r && r.emailAddress;
  if (!e) return '';
  return e.name && e.name !== e.address ? `${e.name} <${e.address}>` : e.address || e.name || '';
}

// The first n characters (UTF-16 code units), never splitting a surrogate pair: an
// emoji at the boundary is left out rather than cut in half.
function cutText(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

function toEntry(m, a) {
  const subject = m.subject || '';
  // A forward's quoted part IS the content: keep it.
  const keepQuoted = /^\s*(fw|fwd)\s*:/i.test(subject);
  let raw = String((m.body && m.body.content) || '');
  let truncated = false;
  if (raw.length > MAX_INPUT_CHARS) { raw = cutText(raw, MAX_INPUT_CHARS); truncated = true; }
  let text = cleanText(raw, { keepQuoted });
  const chars = text.length;
  const maxChars = a.maxChars || DEFAULT_MAX_CHARS;
  if (chars > maxChars) { text = cutText(text, maxChars); truncated = true; }
  return {
    id: m.id, from: addr(m.from), to: (m.toRecipients || []).map(addr), cc: (m.ccRecipients || []).map(addr),
    subject, received: m.receivedDateTime, hasAttachments: !!m.hasAttachments, text, chars, truncated,
  };
}


// A Softeria tool error ("Microsoft Graph API error: 404 Not Found - {...}") as
// a short per-message error.
function toolError(e) {
  const text = String((e && e.message) || e);
  if (/ErrorItemNotFound|404 Not Found/.test(text)) return 'not found';
  const m = /\\?"code\\?":\\?"(\w+)\\?",\\?"message\\?":\\?"([^"\\]{0,160})/.exec(text);
  return m ? `${m[1]}: ${m[2]}` : text.slice(0, 200);
}

// callTool(name, args) -> the parsed JSON result of a Softeria tool, run as the
// caller; it throws on a tool error. Only Softeria's ordinary mail tools are
// used: get-mail-message per id (in parallel) and list-mail-folder-messages for
// a folder, so Softeria's own text bodies and $search normalisation apply and
// no generic Graph tool is needed.
async function readMailText(args, callTool, maxResponseChars) {
  const a = validate(args);
  let messages;
  if (a.messageIds) {
    messages = await Promise.all(a.messageIds.map(async (id) => {
      try { return (await callTool('get-mail-message', { messageId: id, select: SELECT })) || {}; } catch (e) {
        if (e && e.refusal) throw e; // the caller was refused (token/allowlist): not a per-message error
        return { id, error: toolError(e) };
      }
    }));
  } else {
    const q = { mailFolderId: a.folderId, top: a.top || MAX_TOP, select: SELECT };
    if (a.filter !== undefined) q.filter = a.filter;
    if (a.search !== undefined) q.search = a.search;
    const r = await callTool('list-mail-folder-messages', q);
    messages = (r && Array.isArray(r.value)) ? r.value : [];
  }
  const out = messages.map((m) => (m.error ? m : toEntry(m, a)));
  const json = JSON.stringify(out);
  if (json.length > maxResponseChars) {
    const largest = out.filter((m) => m.text !== undefined).sort((x, y) => y.text.length - x.text.length).slice(0, 5)
      .map((m) => `"${(m.subject || '(no subject)').slice(0, 60)}" ${m.text.length.toLocaleString('en-US')}`).join(', ');
    throw new ToolError(
      `Response would be ${json.length.toLocaleString('en-US')} characters (limit ${maxResponseChars.toLocaleString('en-US')}). ` +
      `Largest: ${largest}. Narrow the query (fewer messages via top, a filter such as a date range or sender, ` +
      'specific messageIds) or set a smaller maxChars.');
  }
  return out;
}

module.exports = { TOOL_NAME, TOOL_DEF, ToolError, cleanText, readMailText, MAX_IDS, MAX_TOP, MAX_INPUT_CHARS, DEFAULT_MAX_CHARS };
