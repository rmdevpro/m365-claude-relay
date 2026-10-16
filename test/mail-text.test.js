// node --test m365-relay/test/
const test = require('node:test');
const assert = require('node:assert');
const { cleanText, isForwardSubject, readMailText, ToolError, MAX_INPUT_CHARS, DEFAULT_MAX_CHARS } = require('../mail-text');

const L = (d) => `⟦link: ${d}⟧`;

test('quoted reply history (On ... wrote:) is removed', () => {
  const t = cleanText('Sounds good, Tuesday works.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul <paul@x.com> wrote:\n> Can we meet?\n> Paul');
  assert.strictEqual(t, 'Sounds good, Tuesday works.\n\n');
});

test('two-line On/wrote header is removed', () => {
  assert.strictEqual(cleanText('Yes.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul Smith\n<paul@x.com> wrote:\nold text'), 'Yes.\n\n');
});

test('Outlook From/Sent header block and Original Message separator are removed', () => {
  assert.strictEqual(cleanText('Attached is the quote.\n\n________________________________\nFrom: Paul\nSent: Tuesday\nTo: J\nSubject: quote\n\nold'), 'Attached is the quote.\n\n');
  assert.strictEqual(cleanText('New text\r\n\r\nFrom: Paul Smith <p@x.com>\r\nSent: Tuesday, October 7, 2026\r\nTo: J\r\nSubject: Re: x\r\n\r\nolder'), 'New text\n\n');
  assert.strictEqual(cleanText('Fine.\n-----Original Message-----\nFrom: a\nold'), 'Fine.\n');
});

test('a separator line not above a quoted header block is kept (ticket history, receipts)', () => {
  const ticket = 'Latest update.\n________________________________\nMon 10/12 Paul Martin-\nEarlier update.\n________________________________\nFri 10/2 J-\nFirst message.';
  assert.strictEqual(cleanText(ticket), ticket);
  const receipt = 'Thanks for your order.\n____________________\nSubtotal: $799.99\nTax: $0.00';
  assert.strictEqual(cleanText(receipt), receipt);
  assert.strictEqual(cleanText('Reply.\n________________________________\n\nFrom: P\nSent: Tue\nTo: J\nold'), 'Reply.\n');
});

test('text that only looks like quoting is kept: ">" lines and undated "On ... wrote:"', () => {
  const note = 'Build note:\n> Deploy only after the change window.\nPlease acknowledge.';
  assert.strictEqual(cleanText(note), note);
  const doc = 'The parser looks for this literal:\nOn {person} wrote:\nthen the example, which must remain.';
  assert.strictEqual(cleanText(doc), doc);
  // Apple Mail quotes the whole history with ">", its header included.
  assert.strictEqual(cleanText('Top reply\n\n> On Sep 21, 2026, at 12:10 AM, J <j@x.example> wrote:\n>\n> old'), 'Top reply\n\n');
});

test('forwards are recognised in other languages and behind tags', () => {
  for (const subject of [
    'FW: x', 'Fw: x', 'Fwd: x', 'FWD : x', 'VS: x', 'VB: x', 'WG: x', 'TR: x', 'TRS: x', 'RV: x',
    'I: x', 'ENC: x', 'Doorst: x', 'VL: x', 'ED: x', 'FS: x', 'PD: x', 'YML: x', '\u0130LT: x',
    'Tov\u00e1bb\u00edt\u00e1s: x', 'P\u0101rs.: x', '\u03a0\u03a1\u0398: x', '\u8f6c\u53d1: x',
    '\u8f6c\u53d1\uff1ax', '\u8f49\u5bc4: x', '\u05d4\u05d5\u05e2\u05d1\u05e8: x',
    '\u05d4\u05e2\u05d1\u05e8\u05d4: x', '\u0625\u0639\u0627\u062f\u0629 \u062a\u0648\u062c\u064a\u0647: x',
    '\u0bae\u0bc1\u0ba9\u0bcd\u0ba9\u0ba9\u0bc1\u0baa\u0bcd\u0baa\u0bc1: x', '[EXTERNAL] FW: x', '[EXT] [x] Fwd: x',
    // decomposed (NFD) spellings
    'Tova\u0301bbi\u0301ta\u0301s: x', 'Pa\u0304rs.: x', 'I\u0307LT: x',
  ]) {
    assert.strictEqual(isForwardSubject(subject), true, subject);
  }
  for (const subject of ['Re: x', 'RE: FW: x', 'AW: x', 'SV: x', 'Forward: x', 'Info: x', 'x FW: y']) {
    assert.strictEqual(isForwardSubject(subject), false, subject);
  }
});

test('history under an explicit forward marker is kept, whatever the subject', () => {
  const gmail = 'See below.\n\n---------- Forwarded message ---------\nFrom: A <a@x.example>\nDate: Mon, Oct 5, 2026\nSubject: Plan\nTo: B\n\nThe plan.';
  assert.strictEqual(cleanText(gmail), gmail);
  const apple = 'Ok.\n\nBegin forwarded message:\n\nFrom: A\nSubject: x\nDate: 5 Oct 2026\nTo: B\n\nBody';
  assert.strictEqual(cleanText(apple), apple);
});

test('history is kept when nothing precedes it', () => {
  assert.match(cleanText('From: Paul\nSent: Tuesday\nTo: J\nSubject: x\n\nThe content'), /The content/);
});

test('the message itself is never cut: signatures, a bare "--" separator and footer lines are kept', () => {
  assert.strictEqual(cleanText('Thanks,\nJ\n-- \nJ Morrissette | CEO\n+1 555'), 'Thanks,\nJ\n-- \nJ Morrissette | CEO\n+1 555');
  assert.strictEqual(cleanText('On my way.\n\nSent from my iPhone'), 'On my way.\n\nSent from my iPhone');
  // A ticketing system's layout: header, a bare "--", then the actual content.
  const ticket = '520631 - Claude AI Project\nPaul Martin\nMartech\n.\n--\nTue 10/13 Paul Martin-\nStatus and next steps\nWhat we need from Jason\n1. Confirm the scopes.';
  assert.strictEqual(cleanText(ticket), ticket);
  const footerish = 'Your order shipped. Track it from your account page any time you like, it is all there.\n\nQuestions? Reply.\n\nYou are receiving this because you bought something. Unsubscribe here.\n\n© 2026 Shop Inc. All rights reserved.';
  assert.strictEqual(cleanText(footerish), footerish);
  assert.match(cleanText('Short note.\nPlease read our privacy policy\nThe important part comes after it.'), /The important part comes after it\./);
});

test('links: Safe Links unwrapped; short addresses kept in full; long tracking addresses shortened to the real domain', () => {
  const sl = 'https://na01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://www.fedex.com/track?id=1') + '&data=abc';
  assert.strictEqual(cleanText(`See the report<https://www.example.com/r?x=2> and https://docs.foo.org/a/b.\nTrack it<${sl}>`),
    'See the report<https://www.example.com/r?x=2> and https://docs.foo.org/a/b.\nTrack it<https://www.fedex.com/track?id=1>');
  const long = 'https://click.mailer.example.com/ls/click?upn=' + 'A'.repeat(350);
  assert.strictEqual(cleanText(`Read more<${long}>`), `Read more${L('click.mailer.example.com')}`);
  const longSafe = 'https://na01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://www.linkedin.com/comm/feed/?x=' + 'x'.repeat(350)) + '&data=abc';
  assert.strictEqual(cleanText(`Feed<${longSafe}>`), `Feed${L('linkedin.com')}`);
  assert.strictEqual(cleanText('See (https://en.wikipedia.org/wiki/Foo_(bar)).'), 'See (https://en.wikipedia.org/wiki/Foo_(bar)).');
  assert.strictEqual(cleanText('(413) 539 3059<tel:4135393059> a@b.com<mailto:a@b.com>'), '(413) 539 3059<tel:4135393059> a@b.com<mailto:a@b.com>');
});

test('Proofpoint and Google redirects are unwrapped, also inside Safe Links', () => {
  // URL Defense v3: "*" and "**<c>" stand for characters listed (base64) after ";".
  const enc = Buffer.from('+++%').toString('base64url');
  assert.strictEqual(cleanText(`Map<https://urldefense.com/v3/__https:/maps.example.com/q/1*Main*St**A0D__;${enc}!!x!y$>`),
    'Map<https://maps.example.com/q/1+Main+St+%0D>');
  assert.strictEqual(cleanText('Site https://urldefense.proofpoint.com/v2/url?u=https-3A__www.example.com_a_b&d=x&e= now'),
    'Site https://www.example.com/a/b now');
  const google = 'https://www.google.com/url?q=' + encodeURIComponent('https://us02web.zoom.us/j/123?pwd=abc') + '&sa=D&ust=1&usg=AOvVaw';
  const safe = 'https://nam12.safelinks.protection.outlook.com/?url=' + encodeURIComponent(google) + '&data=' + 'd'.repeat(200);
  assert.strictEqual(cleanText(`Join<${safe}>`), 'Join<https://us02web.zoom.us/j/123?pwd=abc>');
});

test('tracking parameters are dropped; the others are kept', () => {
  assert.strictEqual(cleanText('Job<https://www.linkedin.com/comm/jobs/view/42/?trackingId=abc&refId=x&lipi=y&eid=e1>'),
    'Job<https://www.linkedin.com/comm/jobs/view/42/?eid=e1>');
  // LinkedIn's parameter names are tracking only on LinkedIn links.
  assert.strictEqual(cleanText('Redeem: https://portal.example/redeem?midsig=signature&case=42'), 'Redeem: https://portal.example/redeem?midsig=signature&case=42');
  // A parameter that may make the link work (a one-time token) is not tracking.
  assert.strictEqual(cleanText('Complete it: https://service.example/approve?otpToken=one-time&case=42'),
    'Complete it: https://service.example/approve?otpToken=one-time&case=42');
  assert.strictEqual(cleanText('https://shop.example/p?id=7&utm_source=mail&utm_campaign=fall'), 'https://shop.example/p?id=7');
  const invite = 'https://calendar.example.com/event?action=RESPOND&eid=' + 'e'.repeat(150) + '&rst=1';
  assert.strictEqual(cleanText(`Yes<${invite}>`), `Yes<${invite}>`);
});

test('a shortened link shows the host the URL really goes to', () => {
  const tail = '/pay?x=' + 'y'.repeat(320);
  assert.strictEqual(cleanText('https://trusted.example(foo)@evil.example' + tail), L('evil.example'));
});

test('a marker cannot be forged from body text', () => {
  const long = 'https://evil.example/x?' + 'z'.repeat(320);
  const t = cleanText(`Pay at [link: login.microsoftonline.com] or ⟦link: login.microsoftonline.com⟧\n${long}`);
  assert.strictEqual(t, `Pay at [link: login.microsoftonline.com] or [link: login.microsoftonline.com]\n${L('evil.example')}`);
  assert.strictEqual((t.match(/⟦/g) || []).length, 1, 'only the real link is a marker');
});

test('square-bracket text is never removed; only placeholders whose address is an image file', () => {
  assert.strictEqual(cleanText('Runbook: [https://portal.example.test/runbook] before deploying.'), 'Runbook: [https://portal.example.test/runbook] before deploying.');
  assert.strictEqual(cleanText('Pixel [https://img.example.com/a/logo.PNG?w=2] here'), 'Pixel  here');
  assert.strictEqual(cleanText('see [JIRA-123] and arr[i] [1] [FedEx]'), 'see [JIRA-123] and arr[i] [1] [FedEx]');
  assert.strictEqual(cleanText('Logo [https://img.example.com/logo.png] here'), 'Logo  here');
});

test('everything else is left as the message has it: link-only lines, whitespace, repeats', () => {
  const links = 'Begin\nhttps://one.example/a\nhttps://one.example/a\n<https://t.example/x> | <https://x.example/y>\nEnd';
  assert.strictEqual(cleanText(links), links);
  const spacing = 'Keep A\u00a0B exactly\nKeep A\t\tB exactly\nFirst\n\n\nThird   \n  indented';
  assert.strictEqual(cleanText(spacing), spacing);
  // Removing an image placeholder removes only the placeholder.
  assert.strictEqual(cleanText('alpha [https://img.example/a.png]omega'), 'alpha omega');
  assert.strictEqual(cleanText('Hi\n  [https://img.example/a.png]\nBye'), 'Hi\n  \nBye');
  // Quoted history starts at its header; the blank lines above it are the reply's.
  assert.strictEqual(cleanText('Reply.\n\n\nOn Tue, 7 Oct 2026 at 10:00, Paul <p@example.com> wrote:\nold'), 'Reply.\n\n\n');
  // Line endings become \n.
  assert.strictEqual(cleanText('A\r\nB\rC'), 'A\nB\nC');
});

test('a single invisible character that is part of the text is kept', () => {
  assert.strictEqual(cleanText('co\u00adoperate and a\u200bb'), 'co\u00adoperate and a\u200bb');
});

test('invisible preheader padding runs are removed', () => {
  assert.strictEqual(cleanText('Sale\u200b\u034f\u200c\u034f \u200c\u034f today'), 'Sale today');
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
    'url defense stars': 'https://urldefense.com/v3/__https:/a.b/' + '*'.repeat(4000) + '__;' + 'A'.repeat(4000) + '!',
    'url defense runs': ('https://urldefense.com/v3/__' + '**A'.repeat(1300) + '__;!! ').repeat(50),
    'separators': '______________________________\n\n\n'.repeat(30000),
    'distinct link-only lines': Array.from({ length: 14000 }, (_, i) => `https://a.example/${i}`).join('\n').slice(0, MAX_INPUT_CHARS),
    'quoted header lines': '> On 1 x wrote: y\n'.repeat(15000),
    'padding runs': '\u034f \u200c'.repeat(100000),
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
    return msg('A', 'Hello', 'Hi J\n\nOn Mon, 6 Oct 2026, Paul wrote:\n> old');
  };
  const out = await readMailText({ messageIds: ['A', 'B/=', 'bad'] }, callTool, 80000);
  assert.deepStrictEqual(calls.map((c) => [c.name, c.args.messageId]), [['get-mail-message', 'A'], ['get-mail-message', 'B/='], ['get-mail-message', 'bad']]);
  assert.match(calls[0].args.select, /\bbody\b/);
  assert.deepStrictEqual(out[0], { id: 'A', from: 'Paul <p@x.com>', to: ['J <j@y.com>'], cc: [], subject: 'Hello',
    received: '2026-10-07T10:00:00Z', hasAttachments: false, text: 'Hi J\n\n', chars: 6, truncated: false });
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
  const callTool = async () => ({ value: [msg('A', 'FW: contract', 'FYI\n-- \nJ\n\nFrom: Paul\nSent: Mon\nTo: J\nSubject: contract\n\nThe terms are attached.'),
    msg('B', 'VS: kontrakt', 'FYI\n\nFrom: Paul\nSent: Mon\nTo: J\nSubject: kontrakt\n\nVilkårene er vedlagt.'),
    msg('C', 'Tova\u0301bbi\u0301ta\u0301s: contract', 'FYI\n\nFrom: A\nSent: now\nTo: B\nSubject: old\n\nforward content')] });
  const [m, vs, nfd] = await readMailText({ folderId: 'inbox' }, callTool, 80000);
  assert.match(nfd.text, /forward content/);
  assert.match(m.text, /The terms are attached\./);
  assert.match(vs.text, /Vilkårene er vedlagt\./);
});

test('each message is cut to 3,000 characters by default; a larger maxChars returns more', async () => {
  const long = 'word '.repeat(5000).trim();
  const callTool = async () => ({ value: [msg('A', 'long', long), msg('B', 'short', 'Hi')] });
  const [byDefault, short] = await readMailText({ folderId: 'inbox' }, callTool, 80000);
  assert.strictEqual(byDefault.text, long.slice(0, DEFAULT_MAX_CHARS));
  assert.strictEqual(byDefault.chars, long.length);
  assert.strictEqual(byDefault.truncated, true);
  assert.strictEqual(short.text, 'Hi');
  assert.strictEqual(short.truncated, false);
  const [full] = await readMailText({ folderId: 'inbox', maxChars: 300000 }, callTool, 80000);
  assert.strictEqual(full.text, long);
  assert.strictEqual(full.truncated, false);
  const [cut] = await readMailText({ folderId: 'inbox', maxChars: 100 }, callTool, 80000);
  assert.strictEqual(cut.text.length, 100);
  assert.strictEqual(cut.truncated, true);
});

test('a character is never cut in half at the default cut or the input cap', async () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const atDefault = 'x'.repeat(DEFAULT_MAX_CHARS - 1) + '\u{1F600}tail';
  const [a] = await readMailText({ folderId: 'inbox' }, async () => ({ value: [msg('A', 'a', atDefault)] }), 80000);
  assert.strictEqual(a.text, 'x'.repeat(DEFAULT_MAX_CHARS - 1));
  assert.strictEqual(a.truncated, true);
  const atCap = 'x'.repeat(MAX_INPUT_CHARS - 1) + '\u{1F600}tail';
  const [b] = await readMailText({ folderId: 'inbox', maxChars: MAX_INPUT_CHARS }, async () => ({ value: [msg('B', 'b', atCap)] }), 1000000);
  assert.strictEqual(lone.test(b.text), false);
  assert.strictEqual(b.truncated, true);
});

test('maxChars above 300,000 is refused before any call', async () => {
  let called = false;
  await assert.rejects(readMailText({ folderId: 'inbox', maxChars: MAX_INPUT_CHARS + 1 }, async () => { called = true; return { value: [] }; }, 80000), ToolError);
  assert.strictEqual(called, false);
});

test('an enormous body is cleaned only up to the input cap and marked truncated', async () => {
  const callTool = async () => ({ value: [msg('A', 'huge', 'z '.repeat(MAX_INPUT_CHARS))] });
  const [m] = await readMailText({ folderId: 'inbox', maxChars: 50 }, callTool, 80000);
  assert.strictEqual(m.truncated, true);
  assert.ok(m.chars <= MAX_INPUT_CHARS);
});

test('oversize response is refused whole with the largest messages and advice', async () => {
  const callTool = async () => ({ value: [msg('A', 'Weekly digest', 'x'.repeat(60000)), msg('B', 'Re: contract', 'y'.repeat(30000)), msg('C', 'short', 'z')] });
  await assert.rejects(readMailText({ folderId: 'inbox', maxChars: 100000 }, callTool, 80000), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /^Response would be [\d,]+ characters \(limit 80,000\)\. Largest: "Weekly digest" 60,000, "Re: contract" 30,000/);
    assert.match(e.message, /filter/);
    assert.match(e.message, /maxChars/);
    return true;
  });
  assert.strictEqual((await readMailText({ folderId: 'inbox', maxChars: 1000 }, callTool, 80000)).length, 3);
  // The default cut keeps the same page inside the limit.
  assert.strictEqual((await readMailText({ folderId: 'inbox' }, callTool, 80000)).length, 3);
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
