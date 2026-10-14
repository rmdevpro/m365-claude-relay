// read-mail-text (Infra #96): mail messages as text with the bulk junk removed.
//
// Rule: remove obvious junk, never cut or rewrite the message itself. Bodies come
// from Softeria's own mail tools as plain text (its default body format); then
// cleanText() removes invisible padding characters, image placeholders whose only
// content is an image address, and quoted reply history (earlier messages pasted
// below a reply; forwards keep theirs). Links are kept: Outlook Safe Links are
// unwrapped to the real address, which is kept in full when it is short; only long
// (tracking-style) addresses are shortened to ⟦link: domain⟧. Signatures, footers
// and everything else in the message are left as they are.
//
// Mail bodies are attacker-controlled: every pattern is bounded and linear, the
// cleaner reads at most MAX_INPUT_CHARS per message (beyond that the message is
// marked truncated), and a link marker cannot be forged from body text (the
// marker brackets are neutralised in the input). Nothing is cut silently: text
// is complete unless maxChars or the input cap applied (truncated: true), and a
// response over the limit is refused whole with advice to narrow the query.

const MAX_IDS = 20;
const MAX_TOP = 20;
const MAX_INPUT_CHARS = 300_000;
const SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,body';

const TOOL_NAME = 'read-mail-text';
const TOOL_DEF = {
  name: TOOL_NAME,
  title: 'Read mail as clean text',
  description:
    'Read up to 20 mail messages as text with the bulk junk removed: invisible padding, image placeholders and ' +
    'quoted reply history (forwards keep theirs). Links are kept, unwrapped from Outlook Safe Links; only long ' +
    'tracking-style addresses are shortened to ⟦link: domain⟧. The message itself, including signatures and ' +
    'footers, is never cut or rewritten. Use get-mail-message for the raw body or the quoted thread. Give ' +
    'messageIds, or folderId with optional top and filter or search (newest first). ' +
    'Text is cut only when maxChars is set or a message is enormous (truncated: true). If the whole result would ' +
    'be too large the call fails, naming the largest messages: narrow it with fewer messages, a filter, or maxChars.',
  inputSchema: {
    type: 'object',
    properties: {
      messageIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_IDS, description: `Message ids to read (max ${MAX_IDS}). Give messageIds or folderId, not both.` },
      folderId: { type: 'string', description: 'Folder to read from: a well-known name (inbox, sentitems, drafts, archive, deleteditems, junkemail) or a folder id.' },
      top: { type: 'integer', minimum: 1, maximum: MAX_TOP, description: `With folderId: how many messages, newest first (default and max ${MAX_TOP}).` },
      filter: { type: 'string', description: "With folderId: OData $filter, e.g. receivedDateTime ge 2026-10-01T00:00:00Z or from/emailAddress/address eq 'a@b.com'." },
      search: { type: 'string', description: 'With folderId: KQL search, e.g. from:paul subject:"quarterly report". Cannot be combined with filter.' },
      maxChars: { type: 'integer', minimum: 1, description: 'Optional: cut each message text to this many characters (marked truncated). Unset = full cleaned text.' },
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
const MARK_RE = /⟦link: [^⟦⟧\n]{1,300}⟧/g;
const MAX_KEPT_URL = 120; // longer addresses are tracking-style junk: shortened to the domain

const QUOTE_START = [
  /^On .{1,300}wrote:\s*$/i,                              // Gmail/Apple: On <date>, <name> wrote:
  /^-{2,}\s*Original Message\s*-{2,}/i,                   // Outlook classic
  /^_{10,}\s*$/,                                           // Outlook separator before From:/Sent:
  /^Le .{1,300}a écrit\s*:\s*$/i, /^Am .{1,300}schrieb .{0,200}:\s*$/i,
];
const HEADER_FROM = /^\*?From:\*?\s+\S/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject):\*?\s/i;

function quoteStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.length > 2000) continue; // header lines are short; skip giant lines cheaply
    if (QUOTE_START.some((r) => r.test(l))) return i;
    // "On Tue, 1 Oct 2026 at 10:00, Paul\n<paul@x.com> wrote:" split over two lines
    if (/^On .{1,200}/i.test(l) && i + 1 < lines.length && l.length + lines[i + 1].length < 320 && /wrote:\s*$/i.test(lines[i + 1].trim())) return i;
    if (HEADER_FROM.test(l)) {
      let k = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) if (lines[j].length < 2000 && HEADER_NEXT.test(lines[j].trim())) k++;
      if (k >= 2) return i;
    }
  }
  return -1;
}

// The real address behind a link: Outlook/Defender Safe Links wrap it.
function unwrap(u) {
  try {
    const url = new URL(u);
    const wrapped = url.searchParams.get('url');
    if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(url.hostname) && wrapped) return new URL(wrapped).href;
    return u;
  } catch { return u; }
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

function cleanLinks(t) {
  // "[<image url>]": an image placeholder whose only content is its address.
  t = t.replace(/\[[ \t]{0,20}https?:\/\/[^\s<>"'[\]⟦⟧]{1,4096}[ \t]{0,20}\]/gi, '');
  // Graph's text conversion writes anchors as "label<https://...>"; bare URLs also
  // occur. Every quantifier is bounded and the delimiters are excluded from the
  // runs, so a hostile body stays linear.
  t = t.replace(/<((?:https?|mailto|tel):[^<>\s]{1,4096})>/gi, (m, u) => {
    if (/^(mailto|tel):/i.test(u)) return m;
    const shown = showLink(u);
    return shown.startsWith(MARK_OPEN) ? ` ${shown}` : ` <${shown}>`;
  });
  t = t.replace(/(^|[^<])\b(https?:\/\/[^\s<>"'[\]⟦⟧]{1,4096})/gi, (m, pre, raw) => {
    const [u, tail] = splitUrlTail(raw);
    return pre + showLink(u) + tail;
  });
  return t;
}

const LINK_TOKEN = /<?https?:\/\/[^\s<>]{1,4096}>?|⟦link: [^⟦⟧\n]{1,300}⟧/g;

function cleanText(raw, opts = {}) {
  const t = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍⁠﻿­]|͏/g, '')   // zero-width / preheader padding
    .replace(/[   ]/g, ' ')
    .replace(/⟦/g, '[').replace(/⟧/g, ']');          // marker brackets cannot come from the body
  let lines = t.split('\n');

  if (!opts.keepQuoted) {
    const q = quoteStart(lines);
    if (q >= 0 && lines.slice(0, q).join('').trim()) lines = lines.slice(0, q);
    lines = lines.filter((l) => !/^\s*>/.test(l));
  }

  lines = cleanLinks(lines.join('\n')).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
  // Runs of lines that are nothing but links (nav bars, social icons) collapse to
  // one line of their distinct links: every link stays, the line clutter goes.
  const out = [];
  let run = null;
  for (const l of lines) {
    const links = l.match(LINK_TOKEN);
    const linkOnly = links && l.replace(LINK_TOKEN, '').replace(/[\s|•·\-–]/g, '') === '';
    if (linkOnly) {
      if (!run) { run = []; out.push(run); }
      for (const k of links) if (!run.includes(k)) run.push(k);
    } else { run = null; out.push(l); }
  }
  return out.map((x) => (Array.isArray(x) ? x.join(' ') : x)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  if (a.maxChars !== undefined && !(Number.isInteger(a.maxChars) && a.maxChars > 0)) throw new ToolError('maxChars must be a positive integer');
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

function toEntry(m, a) {
  const subject = m.subject || '';
  // A forward's quoted part IS the content: keep it.
  const keepQuoted = /^\s*(fw|fwd)\s*:/i.test(subject);
  let raw = String((m.body && m.body.content) || '');
  let truncated = false;
  if (raw.length > MAX_INPUT_CHARS) { raw = raw.slice(0, MAX_INPUT_CHARS); truncated = true; }
  let text = cleanText(raw, { keepQuoted });
  const chars = text.length;
  if (a.maxChars && chars > a.maxChars) { text = text.slice(0, a.maxChars); truncated = true; }
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
      'specific messageIds) or set maxChars to shorten each message.');
  }
  return out;
}

module.exports = { TOOL_NAME, TOOL_DEF, ToolError, cleanText, readMailText, MAX_IDS, MAX_TOP, MAX_INPUT_CHARS };
