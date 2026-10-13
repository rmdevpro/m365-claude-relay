// read-mail-text (Infra #96): the text of mail messages with the clutter removed.
//
// Bodies come from Softeria as plain text (its default body format), then
// cleanText() removes quoted reply history, the "-- " signature, mobile
// sign-offs, a trailing footer block and image placeholders, and shortens links
// to ⟦link: domain⟧. Cleaning is deterministic and pattern-based: it removes
// clutter only and never summarises, but it is a lossy view; get-mail-message
// gives the exact text and links.
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
const PREFER_TEXT = 'outlook.body-content-type="text"';

const TOOL_NAME = 'read-mail-text';
const TOOL_DEF = {
  name: TOOL_NAME,
  title: 'Read mail as clean text',
  description:
    'Triage view of up to 20 mail messages: the text with quoted reply history, signatures, footers (unsubscribe, ' +
    'legal notices), image placeholders and tracking links removed; links appear as ⟦link: domain⟧. It never ' +
    'summarises, but the cleaning is pattern-based and lossy: use get-mail-message for the exact text, full links ' +
    'or the quoted thread. Give messageIds, or folderId with optional top and filter or search (newest first). ' +
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

const QUOTE_START = [
  /^On .{1,300}wrote:\s*$/i,                              // Gmail/Apple: On <date>, <name> wrote:
  /^-{2,}\s*Original Message\s*-{2,}/i,                   // Outlook classic
  /^_{10,}\s*$/,                                           // Outlook separator before From:/Sent:
  /^Le .{1,300}a écrit\s*:\s*$/i, /^Am .{1,300}schrieb .{0,200}:\s*$/i,
];
const HEADER_FROM = /^\*?From:\*?\s+\S/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject):\*?\s/i;
const SIG_LINES = /^(Sent from my \w+|Get Outlook for (iOS|Android)|Sent from (Mail|Outlook) for \w+)\b.{0,200}$/i;
const FOOTER = new RegExp([
  '\\bunsubscribe\\b', 'view (this (e-?mail|message) )?(in|on) (your |a )?(web )?browser', 'manage (your )?(e-?mail |subscription |communication )?preferences',
  'privacy (policy|notice|statement)', '\\bopt[ -]out\\b', "you('re| are) receiving (this|these|[\\w ]{0,40}(e-?mails?|messages|notifications))", 'this (e-?mail|message)( and any (files|attachments)[^.]{0,40})? (is|are|may be|contains?) (strictly )?(confidential|privileged|intended)',
  'this (e-?mail|message) was (sent|intended) (to|for)\\b', 'if you (are not|have received this)[^.]{0,60}(intended recipient|in error)', '©', '\\bcopyright\\s+(©\\s*)?\\d{4}', 'all rights reserved',
].join('|'), 'i');

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

function linkHost(u) {
  try {
    let url = new URL(u);
    // Outlook/Defender Safe Links wrap the real target: show the real domain.
    if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(url.hostname) && url.searchParams.get('url')) url = new URL(url.searchParams.get('url'));
    return url.hostname.replace(/^www\./, '') || 'link';
  } catch { return 'link'; }
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

function shortenLinks(t) {
  // Graph's text conversion writes anchors as "label<https://...>", images as
  // "[alt]" and image sources as "[https://...]". Every quantifier is bounded and
  // the delimiters are excluded from the runs, so a hostile body stays linear.
  t = t.replace(/<((?:https?|mailto|tel):[^<>\s]{1,4096})>/gi, (m, u) => (/^(mailto|tel):/i.test(u) ? '' : ` ${mark(linkHost(u))}`));
  t = t.replace(/\bhttps?:\/\/[^\s<>"'[\]⟦⟧]{1,4096}/gi, (raw) => {
    const [u, tail] = splitUrlTail(raw);
    return mark(linkHost(u)) + tail;
  });
  // "[<image url>]": an image placeholder whose only content is its source.
  t = t.replace(/\[[ \t]{0,20}⟦link: [^⟦⟧\n]{1,300}⟧[ \t]{0,20}\]/g, '');
  return t;
}

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
    // Signature: RFC 3676 delimiter "-- " (also bare "--"). Not for forwards: the
    // forwarded message usually sits below the sender's signature.
    const sig = lines.findIndex((l) => l === '-- ' || l === '--');
    if (sig > 0 && lines.slice(0, sig).join('').trim()) lines = lines.slice(0, sig);
  }
  lines = lines.filter((l) => l.length > 300 || !SIG_LINES.test(l.trim()));

  lines = shortenLinks(lines.join('\n')).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
  // Runs of lines that are nothing but links (nav bars, social icons) collapse to
  // one line of their distinct markers: the links stay visible, the clutter goes.
  const out = [];
  let run = null;
  for (const l of lines) {
    const marks = l.match(MARK_RE);
    const linkOnly = marks && l.replace(MARK_RE, '').replace(/[\s|•·\-–]/g, '') === '';
    if (linkOnly) {
      if (!run) { run = []; out.push(run); }
      for (const m of marks) if (!run.includes(m)) run.push(m);
    } else { run = null; out.push(l); }
  }
  lines = out.map((x) => (Array.isArray(x) ? x.join(' ') : x));

  // Footer: from the first footer-like line in the second half of the text to the
  // end, walking back over footer-like lines just above it (a block can straddle
  // the midpoint). Only reasonably short lines are tested.
  const isFooter = (l) => l.length <= 2000 && FOOTER.test(l);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (seen >= total / 2 && isFooter(lines[i])) {
      let cut = i;
      for (let j = cut - 1; j >= Math.max(0, cut - 4); j--) if (isFooter(lines[j])) cut = j;
      if (lines.slice(0, cut).join('').trim()) lines = lines.slice(0, cut);
      break;
    }
    seen += lines[i].length + 1;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

function graphError(status, body) {
  const e = body && body.error;
  return e ? `${e.code || status}: ${e.message || ''}`.trim() : `HTTP ${status}`;
}

// callTool(name, args) -> the parsed JSON result of a Softeria tool, run as the
// caller; it throws on a tool error. Folder reads go through
// list-mail-folder-messages so Softeria's own $search normalisation applies (and
// bodies arrive as text, its default); ids through one graph-batch.
async function readMailText(args, callTool, maxResponseChars) {
  const a = validate(args);
  let messages;
  if (a.messageIds) {
    const requests = a.messageIds.map((id, i) => ({
      id: String(i), method: 'GET', url: `/me/messages/${encodeURIComponent(id)}?$select=${SELECT}`, headers: { Prefer: PREFER_TEXT },
    }));
    const r = await callTool('graph-batch', { body: { requests } });
    const byId = new Map(((r && r.responses) || []).map((x) => [String(x.id), x]));
    messages = a.messageIds.map((id, i) => {
      const x = byId.get(String(i));
      if (!x) return { id, error: 'no response' };
      if (x.status !== 200) return { id, error: x.status === 404 ? 'not found' : graphError(x.status, x.body) };
      return x.body || {};
    });
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
