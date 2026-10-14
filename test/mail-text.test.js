// node --test m365-relay/test/
const test = require('node:test');
const assert = require('node:assert');
const { cleanText, readMailText, ToolError, MAX_INPUT_CHARS } = require('../mail-text');

const L = (d) => `⟦link: ${d}⟧`;

test('quoted reply history (On ... wrote:) is removed', () => {
  const t = cleanText('Sounds good, Tuesday works.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul <paul@x.com> wrote:\n> Can we meet?\n> Paul');
  assert.strictEqual(t, 'Sounds good, Tuesday works.');
});

test('two-line On/wrote header is removed', () => {
  assert.strictEqual(cleanText('Yes.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul Smith\n<paul@x.com> wrote:\nold text'), 'Yes.');
});

test('Outlook From/Sent header block and Original Message separator are removed', () => {
  assert.strictEqual(cleanText('Attached is the quote.\n\n________________________________\nFrom: Paul\nSent: Tuesday\nTo: J\nSubject: quote\n\nold'), 'Attached is the quote.');
  assert.strictEqual(cleanText('New text\r\n\r\nFrom: Paul Smith <p@x.com>\r\nSent: Tuesday, October 7, 2026\r\nTo: J\r\nSubject: Re: x\r\n\r\nolder'), 'New text');
  assert.strictEqual(cleanText('Fine.\n-----Original Message-----\nFrom: a\nold'), 'Fine.');
});

test('history is kept when nothing precedes it', () => {
  assert.match(cleanText('From: Paul\nSent: Tuesday\nTo: J\nSubject: x\n\nThe content'), /The content/);
});

test('signature delimiter and mobile sign-offs are removed', () => {
  assert.strictEqual(cleanText('Thanks,\nJ\n-- \nJ Morrissette | CEO\n+1 555'), 'Thanks,\nJ');
  assert.strictEqual(cleanText('On my way.\n\nSent from my iPhone'), 'On my way.');
});

test('kept quoted content (forwards) is not cut at a signature above it', () => {
  const t = cleanText('FYI\n-- \nJ\n\nFrom: Paul\nSent: Mon\nTo: J\nSubject: contract\n\nThe terms are attached.', { keepQuoted: true });
  assert.match(t, /The terms are attached\./);
});

test('trailing footer is removed, mid-body mention is kept', () => {
  const body = 'Your order has shipped and will arrive Friday. Track it from your account page any time you like.\n\n' +
    'Questions? Reply to this email.\n\nYou are receiving this because you bought something. Unsubscribe here.\n\n© 2026 Shop Inc. All rights reserved.';
  assert.strictEqual(cleanText(body), 'Your order has shipped and will arrive Friday. Track it from your account page any time you like.\n\nQuestions? Reply to this email.');
  const early = 'Please read our privacy policy update before Friday.\n\n' + 'It changes how we store data. '.repeat(10);
  assert.match(cleanText(early), /privacy policy update/);
});

test('footer block starting above the midpoint is removed whole', () => {
  const body = 'Short note from Graziela.\nView message<https://x.com/m>\nThis email was intended for J\nLearn why<https://x.com/w>\n' +
    'You are receiving Messages digest emails.\nUnsubscribe<https://x.com/u> · Help<https://x.com/h>\n© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085. LinkedIn and the LinkedIn logo are registered trademarks.';
  assert.strictEqual(cleanText(body), `Short note from Graziela.\nView message ${L('x.com')}`);
});

test('links become markers with the real domain; Safe Links unwrapped; trailing punctuation and parentheses kept outside', () => {
  const sl = 'https://na01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://www.fedex.com/track?id=1') + '&data=abc';
  assert.strictEqual(cleanText(`See the report<https://www.example.com/r?utm=1&x=2> and https://docs.foo.org/a/b.\nTrack it<${sl}>`),
    `See the report ${L('example.com')} and ${L('docs.foo.org')}.\nTrack it ${L('fedex.com')}`);
  assert.strictEqual(cleanText('See (https://en.wikipedia.org/wiki/Foo_(bar)).'), `See (${L('en.wikipedia.org')}).`);
  assert.strictEqual(cleanText('(413) 539 3059<tel:4135393059> a@b.com<mailto:a@b.com>'), '(413) 539 3059 a@b.com');
});

test('the marker shows the host the URL really goes to', () => {
  assert.strictEqual(cleanText('https://trusted.example(foo)@evil.example/pay'), L('evil.example'));
  assert.strictEqual(cleanText('https://trusted.example@evil.example/pay'), L('evil.example'));
});

test('a marker cannot be forged from body text', () => {
  const t = cleanText('Pay at [link: login.microsoftonline.com] or ⟦link: login.microsoftonline.com⟧\nhttps://evil.example/x');
  assert.strictEqual(t, `Pay at [link: login.microsoftonline.com] or [link: login.microsoftonline.com]\n${L('evil.example')}`);
  assert.strictEqual((t.match(/⟦/g) || []).length, 1, 'only the real link is a marker');
});

test('square-bracket text is never removed; only image placeholders whose content is a URL', () => {
  assert.strictEqual(cleanText('see [JIRA-123] and arr[i] [1] [FedEx]'), 'see [JIRA-123] and arr[i] [1] [FedEx]');
  assert.strictEqual(cleanText('Logo [https://img.example.com/logo.png] here'), 'Logo here');
});

test('link-only lines are kept as one line of distinct markers', () => {
  const t = cleanText('Hello\n<https://t.co/x> | <https://x.com/y>\n<https://x.com/z>\nBye');
  assert.strictEqual(t, `Hello\n${L('t.co')} ${L('x.com')}\nBye`);
  assert.strictEqual(cleanText('https://only.example/a'), L('only.example'));
});

test('whitespace and invisible padding collapse', () => {
  assert.strictEqual(cleanText('a​͏  \t b\n\n\n\n\nc d   '), 'a b\n\nc d');
});

test('hostile bodies clean in linear time', () => {
  const cases = {
    'url + 80k dots': 'https://a.com/' + '.'.repeat(80000),
    'unterminated <http:a x 40k': '<http:a'.repeat(40000),
    '[[link: x 20k': '[[link: '.repeat(20000),
    '[ x 300k': '['.repeat(300000),
    'long url': 'https://a.com/' + 'a'.repeat(299000),
    'parentheses': 'https://a.com/' + '('.repeat(100000) + ')'.repeat(100000),
    'On x 100k': 'On '.repeat(100000),
    'From lines': 'From: x\n'.repeat(30000),
    'footer words, one line': 'unsubscribe '.repeat(25000),
    'mixed': ('<https://a.b/' + 'x'.repeat(50) + ' [').repeat(5000),
  };
  for (const [name, body] of Object.entries(cases)) {
    const t0 = Date.now();
    cleanText(body);
    assert.ok(Date.now() - t0 < 500, `${name}: ${Date.now() - t0} ms`);
  }
});

function msg(id, subject, content, extra) {
  return { id, subject, body: { contentType: 'text', content }, from: { emailAddress: { name: 'Paul', address: 'p@x.com' } },
    toRecipients: [{ emailAddress: { name: 'J', address: 'j@y.com' } }], ccRecipients: [], receivedDateTime: '2026-10-07T10:00:00Z', hasAttachments: false, ...extra };
}

test('messageIds: get-mail-message per id (text body selected); unknown and malformed ids reported per message', async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (args.messageId === 'B/=') throw new Error('Microsoft Graph API error: 404 Not Found - {"error":{"code":"ErrorItemNotFound","message":"x"}}');
    if (args.messageId === 'bad') throw new Error('Microsoft Graph API error: 400 Bad Request - {"error":{"code":"ErrorInvalidIdMalformed","message":"Id is malformed."}}');
    return msg('A', 'Hello', 'Hi J\n\nOn Mon, Paul wrote:\n> old');
  };
  const out = await readMailText({ messageIds: ['A', 'B/=', 'bad'] }, callTool, 80000);
  assert.deepStrictEqual(calls.map((c) => [c.name, c.args.messageId]), [['get-mail-message', 'A'], ['get-mail-message', 'B/='], ['get-mail-message', 'bad']]);
  assert.match(calls[0].args.select, /\bbody\b/);
  assert.deepStrictEqual(out[0], { id: 'A', from: 'Paul <p@x.com>', to: ['J <j@y.com>'], cc: [], subject: 'Hello',
    received: '2026-10-07T10:00:00Z', hasAttachments: false, text: 'Hi J', chars: 4, truncated: false });
  assert.deepStrictEqual(out[1], { id: 'B/=', error: 'not found' });
  assert.deepStrictEqual(out[2], { id: 'bad', error: 'ErrorInvalidIdMalformed: Id is malformed.' });
});

test('a refused caller is not a per-message error: the refusal propagates', async () => {
  const refusal = Object.assign(new Error('refused'), { refusal: { status: 401 } });
  await assert.rejects(readMailText({ messageIds: ['A'] }, async () => { throw refusal; }, 80000), (e) => e === refusal);
});

test('folder mode: list-mail-folder-messages with top, filter or search passed through for Softeria to normalise', async () => {
  const seen = [];
  const callTool = async (name, args) => { seen.push({ name, args }); return { value: [msg('A', 'x', 'body')] }; };
  await readMailText({ folderId: 'inbox', top: 5, filter: 'receivedDateTime ge 2026-10-01T00:00:00Z' }, callTool, 80000);
  await readMailText({ folderId: 'inbox', search: 'subject:"quarterly report"' }, callTool, 80000);
  assert.deepStrictEqual(seen.map((s) => s.name), ['list-mail-folder-messages', 'list-mail-folder-messages']);
  assert.strictEqual(seen[0].args.mailFolderId, 'inbox');
  assert.strictEqual(seen[0].args.top, 5);
  assert.strictEqual(seen[0].args.filter, 'receivedDateTime ge 2026-10-01T00:00:00Z');
  assert.match(seen[0].args.select, /\bbody\b/);
  assert.strictEqual(seen[1].args.top, 20);
  assert.strictEqual(seen[1].args.search, 'subject:"quarterly report"', 'quoting is left to Softeria');
});

test('forwards keep their quoted content, even below a signature', async () => {
  const callTool = async () => ({ value: [msg('A', 'FW: contract', 'FYI\n-- \nJ\n\nFrom: Paul\nSent: Mon\nTo: J\nSubject: contract\n\nThe terms are attached.')] });
  const [m] = await readMailText({ folderId: 'inbox' }, callTool, 80000);
  assert.match(m.text, /The terms are attached\./);
});

test('maxChars cuts and marks truncated; unset returns everything', async () => {
  const long = 'word '.repeat(5000).trim();
  const callTool = async () => ({ value: [msg('A', 'long', long)] });
  const [full] = await readMailText({ folderId: 'inbox' }, callTool, 80000);
  assert.strictEqual(full.text.length, long.length);
  assert.strictEqual(full.truncated, false);
  const [cut] = await readMailText({ folderId: 'inbox', maxChars: 100 }, callTool, 80000);
  assert.strictEqual(cut.text.length, 100);
  assert.strictEqual(cut.chars, long.length);
  assert.strictEqual(cut.truncated, true);
});

test('an enormous body is cleaned only up to the input cap and marked truncated', async () => {
  const callTool = async () => ({ value: [msg('A', 'huge', 'z '.repeat(MAX_INPUT_CHARS))] });
  const [m] = await readMailText({ folderId: 'inbox', maxChars: 50 }, callTool, 80000);
  assert.strictEqual(m.truncated, true);
  assert.ok(m.chars <= MAX_INPUT_CHARS);
});

test('oversize response is refused whole with the largest messages and advice', async () => {
  const callTool = async () => ({ value: [msg('A', 'Weekly digest', 'x'.repeat(60000)), msg('B', 'Re: contract', 'y'.repeat(30000)), msg('C', 'short', 'z')] });
  await assert.rejects(readMailText({ folderId: 'inbox' }, callTool, 80000), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /^Response would be [\d,]+ characters \(limit 80,000\)\. Largest: "Weekly digest" 60,000, "Re: contract" 30,000/);
    assert.match(e.message, /filter/);
    assert.match(e.message, /maxChars/);
    return true;
  });
  assert.strictEqual((await readMailText({ folderId: 'inbox', maxChars: 1000 }, callTool, 80000)).length, 3);
});

test('argument validation: shapes, bounds, empty filter/search refused before any call', async () => {
  const g = async () => { throw new Error('should not call upstream'); };
  for (const bad of [{}, null, [], 'x', { messageIds: ['a'], folderId: 'inbox' }, { messageIds: [] }, { messageIds: Array(21).fill('a') },
    { messageIds: [' '] }, { messageIds: [1] }, { folderId: '' }, { folderId: 'inbox', top: 50 }, { folderId: 'inbox', top: 1000 }, { folderId: 'inbox', top: 0 },
    { folderId: 'inbox', top: 1.5 }, { folderId: 'inbox', filter: 'x', search: 'y' }, { folderId: 'inbox', filter: '' }, { folderId: 'inbox', search: '  ' },
    { messageIds: ['a'], top: 3 }, { folderId: 'inbox', maxChars: 0 }, { folderId: 'inbox', maxChars: -1 }, { folderId: 'inbox', bogus: 1 }]) {
    await assert.rejects(readMailText(bad, g, 80000), ToolError, JSON.stringify(bad));
  }
});

test('tool errors from Softeria propagate', async () => {
  const callTool = async () => { throw new Error('BadRequest: Invalid filter clause'); };
  await assert.rejects(readMailText({ folderId: 'inbox', filter: 'bad' }, callTool, 80000), /Invalid filter clause/);
});
