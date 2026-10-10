// read-mail-text (Infra #96): full message text with the clutter removed.
//
// Graph returns each body as plain text (Prefer: outlook.body-content-type="text"),
// then cleanText() strips quoted history, signatures, trailing footers, long
// links and whitespace runs. Cleaning is deterministic and pattern-based: it
// removes clutter only, never summarises or rewrites. Nothing is truncated unless
// the caller sets maxChars; a response over the absolute limit is refused whole
// with advice to narrow the query (no partial output).

const MAX_IDS = 20;
const MAX_TOP = 20;
const SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,body';
const PREFER_TEXT = 'outlook.body-content-type="text"';

const TOOL_NAME = 'read-mail-text';
const TOOL_DEF = {
  name: TOOL_NAME,
  title: 'Read mail as clean text',
  description:
    'Read the FULL text of one or more email messages, with HTML, quoted reply history, signatures, footers ' +
    '(unsubscribe, legal notices) and long tracking links removed. Use this to read or triage messages instead of ' +
    'get-mail-message. Give messageIds (up to 20), or folderId with optional top/filter/search to read the newest ' +
    'messages in a folder. Text is never cut unless you set maxChars. If the whole result would be too large the ' +
    'call fails with the largest messages listed: narrow it with fewer messages, a filter, or maxChars.',
  inputSchema: {
    type: 'object',
    properties: {
      messageIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_IDS, description: `Message ids to read (max ${MAX_IDS}). Give messageIds or folderId, not both.` },
      folderId: { type: 'string', description: 'Folder to read from: a well-known name (inbox, sentitems, drafts, archive, deleteditems, junkemail) or a folder id.' },
      top: { type: 'integer', minimum: 1, maximum: MAX_TOP, description: `With folderId: how many messages, newest first (default and max ${MAX_TOP}).` },
      filter: { type: 'string', description: "With folderId: OData $filter, e.g. receivedDateTime ge 2026-10-01T00:00:00Z or from/emailAddress/address eq 'a@b.com'." },
      search: { type: 'string', description: 'With folderId: KQL search, e.g. "from:paul subject:invoice". Cannot be combined with filter.' },
      maxChars: { type: 'integer', minimum: 1, description: 'Optional: cut each message text to this many characters (marked truncated). Unset = full text.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Read mail as clean text', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

class ToolError extends Error {}

// ---- cleaning ---------------------------------------------------------------

const QUOTE_START = [
  /^On .{1,300}wrote:\s*$/i,                              // Gmail/Apple: On <date>, <name> wrote:
  /^-{2,}\s*Original Message\s*-{2,}/i,                   // Outlook classic
  /^_{10,}\s*$/,                                           // Outlook separator before From:/Sent:
  /^Le .{1,300}a écrit\s*:\s*$/i, /^Am .{1,300}schrieb .{0,200}:\s*$/i,
];
const HEADER_FROM = /^\*?From:\*?\s+\S/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject):\*?\s/i;
const SIG_LINES = /^(Sent from my \w+|Get Outlook for (iOS|Android)|Sent from (Mail|Outlook) for \w+)\b.*$/i;
const FOOTER = new RegExp([
  '\\bunsubscribe\\b', 'view (this (e-?mail|message) )?(in|on) (your |a )?(web )?browser', 'manage (your )?(e-?mail |subscription |communication )?preferences',
  'privacy (policy|notice|statement)', '\\bopt[ -]out\\b', "you('re| are) receiving (this|these|[\\w ]{0,40}(e-?mails?|messages|notifications))", 'this (e-?mail|message)( and any (files|attachments)[^.]{0,40})? (is|are|may be|contains?) (strictly )?(confidential|privileged|intended)',
  'this (e-?mail|message) was (sent|intended) (to|for)\\b', 'if you (are not|have received this)[^.]{0,60}(intended recipient|in error)', '©', '\\bcopyright\\s+(©\\s*)?\\d{4}', 'all rights reserved',
].join('|'), 'i');

function quoteStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (QUOTE_START.some((r) => r.test(l))) return i;
    // "On Tue, 1 Oct 2026 at 10:00, Paul\n<paul@x.com> wrote:" split over two lines
    if (/^On .{1,200}/i.test(l) && i + 1 < lines.length && /wrote:\s*$/i.test(lines[i + 1].trim()) && l.length + lines[i + 1].length < 320) return i;
    if (HEADER_FROM.test(l)) {
      let k = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) if (HEADER_NEXT.test(lines[j].trim())) k++;
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

function shortenLinks(t) {
  // Graph's text conversion writes anchors as "label<https://...>", images as
  // "[alt text]", and linked images as "[alt]<https://...>"; bare URLs also occur.
  t = t.replace(/<((?:https?|mailto|tel):[^>\s]+)>/gi, (m, u) => (/^(mailto|tel):/i.test(u) ? '' : ` [link: ${linkHost(u)}]`));
  t = t.replace(/\bhttps?:\/\/[^\s<>()"'[\]]+/gi, (u) => {
    const tail = u.match(/[.,;:!?]+$/);
    return `[link: ${linkHost(tail ? u.slice(0, -tail[0].length) : u)}]${tail ? tail[0] : ''}`;
  });
  t = t.replace(/\[\s*(\[link: [^\]]*\])\s*\]/g, '$1');                 // [<url>] image whose alt is its URL
  t = t.replace(/\[([^\[\]\n]{1,80})\](?![ \t]*\[link:)/g, (m, alt) => (/^link: /.test(alt) ? m : ''));  // unlinked image alt text
  t = t.replace(/\[([^\[\]\n]{1,80})\]([ \t]*\[link:)/g, (m, alt, l) => (/^link: /.test(alt) ? m : alt + l)); // linked image -> label
  return t;
}

const LINK_ONLY = (l) => l.replace(/\[link: [^\]]*\]/g, '').replace(/[\s|•·\-–]/g, '') === '';

function cleanText(raw, opts = {}) {
  let t = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]|\u034f/g, '')   // zero-width / preheader padding
    .replace(/[\u00a0\u2007\u202f]/g, ' ');
  let lines = t.split('\n');

  if (!opts.keepQuoted) {
    const q = quoteStart(lines);
    if (q >= 0 && lines.slice(0, q).join('').trim()) lines = lines.slice(0, q);
    lines = lines.filter((l) => !/^\s*>/.test(l));
  }
  // Signature: RFC 3676 delimiter "-- " (also bare "--"), then mobile sign-offs.
  const sig = lines.findIndex((l) => l === '-- ' || l === '--');
  if (sig > 0 && lines.slice(0, sig).join('').trim()) lines = lines.slice(0, sig);
  lines = lines.filter((l) => !SIG_LINES.test(l.trim()));

  // Links, then drop lines that are nothing but links (nav bars, social icons, spacer images).
  lines = shortenLinks(lines.join('\n')).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
  lines = lines.filter((l) => l === '' || !LINK_ONLY(l));

  // Footer: from the first footer-like line in the second half of the text to the end.
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (seen >= total / 2 && FOOTER.test(lines[i])) {
      // The footer block may begin a little earlier (above the midpoint): walk back
      // over nearby footer-like lines (within 4 lines of the current cut).
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) if (FOOTER.test(lines[j])) { i = j; j = i; }
      if (lines.slice(0, i).join('').trim()) lines = lines.slice(0, i);
      break;
    }
    seen += lines[i].length + 1;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- requests and output ----------------------------------------------------

function validate(args) {
  const a = args || {};
  const known = new Set(Object.keys(TOOL_DEF.inputSchema.properties));
  for (const k of Object.keys(a)) if (!known.has(k)) throw new ToolError(`unknown argument "${k}"`);
  const hasIds = a.messageIds !== undefined;
  const hasFolder = a.folderId !== undefined;
  if (hasIds === hasFolder) throw new ToolError('give messageIds or folderId (exactly one)');
  if (a.maxChars !== undefined && !(Number.isInteger(a.maxChars) && a.maxChars > 0)) throw new ToolError('maxChars must be a positive integer');
  if (hasIds) {
    if (!Array.isArray(a.messageIds) || !a.messageIds.length || a.messageIds.some((x) => typeof x !== 'string' || !x)) throw new ToolError('messageIds must be a non-empty list of ids');
    if (a.messageIds.length > MAX_IDS) throw new ToolError(`at most ${MAX_IDS} messageIds per call`);
    if (a.top !== undefined || a.filter !== undefined || a.search !== undefined) throw new ToolError('top, filter and search apply only with folderId');
  } else {
    if (typeof a.folderId !== 'string' || !a.folderId) throw new ToolError('folderId must be a string');
    if (a.top !== undefined && !(Number.isInteger(a.top) && a.top >= 1 && a.top <= MAX_TOP)) throw new ToolError(`top must be 1..${MAX_TOP}`);
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
  let text = cleanText(m.body && m.body.content, { keepQuoted });
  const chars = text.length;
  let truncated = false;
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

// graph(method, path, body, headers) -> { status, body } against the Graph v1.0 root.
async function readMailText(args, graph, maxResponseChars) {
  const a = validate(args);
  let messages;
  if (a.messageIds) {
    const requests = a.messageIds.map((id, i) => ({
      id: String(i), method: 'GET', url: `/me/messages/${encodeURIComponent(id)}?$select=${SELECT}`, headers: { Prefer: PREFER_TEXT },
    }));
    const r = await graph('POST', '/$batch', { requests });
    if (r.status !== 200) throw new ToolError(`Graph batch failed: ${graphError(r.status, r.body)}`);
    const byId = new Map((r.body.responses || []).map((x) => [x.id, x]));
    messages = a.messageIds.map((id, i) => {
      const x = byId.get(String(i));
      if (!x) return { id, error: 'no response' };
      if (x.status !== 200) return { id, error: x.status === 404 ? 'not found' : graphError(x.status, x.body) };
      return x.body;
    });
  } else {
    const q = new URLSearchParams({ $select: SELECT, $top: String(a.top || MAX_TOP) });
    if (a.filter) q.set('$filter', a.filter);
    if (a.search) q.set('$search', a.search.startsWith('"') ? a.search : `"${a.search}"`);
    const r = await graph('GET', `/me/mailFolders/${encodeURIComponent(a.folderId)}/messages?${q}`, null, { Prefer: PREFER_TEXT });
    if (r.status !== 200) throw new ToolError(`Graph request failed: ${graphError(r.status, r.body)}`);
    messages = r.body.value || [];
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

module.exports = { TOOL_NAME, TOOL_DEF, ToolError, cleanText, readMailText, MAX_IDS, MAX_TOP };
