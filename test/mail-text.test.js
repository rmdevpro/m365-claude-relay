// node --test m365-relay/test/
const test = require('node:test');
const assert = require('node:assert');
const { cleanText, readMailText, ToolError } = require('../mail-text');

test('quoted reply history (On ... wrote:) is removed', () => {
  const t = cleanText('Sounds good, Tuesday works.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul <paul@x.com> wrote:\n> Can we meet?\n> Paul');
  assert.strictEqual(t, 'Sounds good, Tuesday works.');
});

test('two-line On/wrote header is removed', () => {
  const t = cleanText('Yes.\n\nOn Tue, 7 Oct 2026 at 10:00, Paul Smith\n<paul@x.com> wrote:\nold text');
  assert.strictEqual(t, 'Yes.');
});

test('Outlook From/Sent header block is removed', () => {
  const t = cleanText('Attached is the quote.\n\n________________________________\nFrom: Paul\nSent: Tuesday\nTo: J\nSubject: quote\n\nold');
  assert.strictEqual(t, 'Attached is the quote.');
  const t2 = cleanText('New text\r\n\r\nFrom: Paul Smith <p@x.com>\r\nSent: Tuesday, October 7, 2026\r\nTo: J\r\nSubject: Re: x\r\n\r\nolder');
  assert.strictEqual(t2, 'New text');
});

test('Original Message separator is removed', () => {
  assert.strictEqual(cleanText('Fine.\n-----Original Message-----\nFrom: a\nold'), 'Fine.');
});

test('history is kept when nothing precedes it', () => {
  assert.match(cleanText('From: Paul\nSent: Tuesday\nTo: J\nSubject: x\n\nThe content'), /The content/);
});

test('signature delimiter and mobile sign-offs are removed', () => {
  assert.strictEqual(cleanText('Thanks,\nJ\n-- \nJ Morrissey | CEO\n+1 555'), 'Thanks,\nJ');
  assert.strictEqual(cleanText('On my way.\n\nSent from my iPhone'), 'On my way.');
});

test('trailing footer is removed, mid-body mention is kept', () => {
  const body = 'Your order has shipped and will arrive Friday. Track it from your account page any time you like.\n\n' +
    'Questions? Reply to this email.\n\nYou are receiving this because you bought something. Unsubscribe here.\n\n© 2026 Shop Inc. All rights reserved.';
  assert.strictEqual(cleanText(body), 'Your order has shipped and will arrive Friday. Track it from your account page any time you like.\n\nQuestions? Reply to this email.');
  const early = 'Please read our privacy policy update before Friday.\n\n' + 'It changes how we store data. '.repeat(10);
  assert.match(cleanText(early), /privacy policy update/);
});

test('links are shortened to their domain; link-only paragraphs dropped', () => {
  const t = cleanText('See the report<https://www.example.com/r?utm=1&x=2> and https://docs.foo.org/a/b.\n\n<https://t.co/x> | <https://x.com/y>');
  assert.strictEqual(t, 'See the report [link: example.com] and [link: docs.foo.org].');
});

test('whitespace and invisible padding collapse', () => {
  assert.strictEqual(cleanText('a\u200b\u034f  \t b\n\n\n\n\nc\u00a0d   '), 'a b\n\nc d');
});

function msg(id, subject, content, extra) {
  return { id, subject, body: { contentType: 'text', content }, from: { emailAddress: { name: 'Paul', address: 'p@x.com' } },
    toRecipients: [{ emailAddress: { name: 'J', address: 'j@y.com' } }], ccRecipients: [], receivedDateTime: '2026-10-07T10:00:00Z', hasAttachments: false, ...extra };
}

test('messageIds: one $batch with plain-text Prefer; mixed found/unknown ids', async () => {
  const calls = [];
  const graph = async (method, p, body, headers) => {
    calls.push({ method, p, body, headers });
    return { status: 200, body: { responses: [
      { id: '1', status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'x' } } },
      { id: '0', status: 200, body: msg('A', 'Hello', 'Hi J\n\nOn Mon, Paul wrote:\n> old') },
    ] } };
  };
  const out = await readMailText({ messageIds: ['A', 'B/='] }, graph, 80000);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].p, '/$batch');
  assert.strictEqual(calls[0].body.requests[1].url.startsWith('/me/messages/B%2F%3D?'), true);
  assert.strictEqual(calls[0].body.requests[0].headers.Prefer, 'outlook.body-content-type="text"');
  assert.deepStrictEqual(out[0], { id: 'A', from: 'Paul <p@x.com>', to: ['J <j@y.com>'], cc: [], subject: 'Hello',
    received: '2026-10-07T10:00:00Z', hasAttachments: false, text: 'Hi J', chars: 4, truncated: false });
  assert.deepStrictEqual(out[1], { id: 'B/=', error: 'not found' });
});

test('folder mode: one list request with top/filter and Prefer header', async () => {
  let seen;
  const graph = async (method, p, body, headers) => { seen = { method, p, headers }; return { status: 200, body: { value: [msg('A', 'x', 'body')] } }; };
  await readMailText({ folderId: 'inbox', top: 5, filter: "receivedDateTime ge 2026-10-01T00:00:00Z" }, graph, 80000);
  assert.strictEqual(seen.method, 'GET');
  assert.match(seen.p, /^\/me\/mailFolders\/inbox\/messages\?/);
  const q = new URLSearchParams(seen.p.split('?')[1]);
  assert.strictEqual(q.get('$top'), '5');
  assert.strictEqual(q.get('$filter'), 'receivedDateTime ge 2026-10-01T00:00:00Z');
  assert.strictEqual(seen.headers.Prefer, 'outlook.body-content-type="text"');
});

test('forwards keep their quoted content', async () => {
  const graph = async () => ({ status: 200, body: { value: [msg('A', 'FW: contract', 'FYI\n\nFrom: Paul\nSent: Mon\nTo: J\nSubject: contract\n\nThe terms are attached.')] } });
  const [m] = await readMailText({ folderId: 'inbox' }, graph, 80000);
  assert.match(m.text, /The terms are attached\./);
});

test('maxChars cuts and marks truncated; unset returns everything', async () => {
  const long = 'word '.repeat(5000).trim();
  const graph = async () => ({ status: 200, body: { value: [msg('A', 'long', long)] } });
  const [full] = await readMailText({ folderId: 'inbox' }, graph, 80000);
  assert.strictEqual(full.text.length, long.length);
  assert.strictEqual(full.truncated, false);
  const [cut] = await readMailText({ folderId: 'inbox', maxChars: 100 }, graph, 80000);
  assert.strictEqual(cut.text.length, 100);
  assert.strictEqual(cut.chars, long.length);
  assert.strictEqual(cut.truncated, true);
});

test('oversize response is refused whole with the largest messages and advice', async () => {
  const graph = async () => ({ status: 200, body: { value: [msg('A', 'Weekly digest', 'x'.repeat(60000)), msg('B', 'Re: contract', 'y'.repeat(30000)), msg('C', 'short', 'z')] } });
  await assert.rejects(readMailText({ folderId: 'inbox' }, graph, 80000), (e) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /^Response would be [\d,]+ characters \(limit 80,000\)\. Largest: "Weekly digest" 60,000, "Re: contract" 30,000/);
    assert.match(e.message, /filter/);
    assert.match(e.message, /maxChars/);
    return true;
  });
  const out = await readMailText({ folderId: 'inbox', maxChars: 1000 }, graph, 80000);
  assert.strictEqual(out.length, 3);
});

test('argument validation', async () => {
  const g = async () => { throw new Error('should not call graph'); };
  for (const bad of [{}, { messageIds: ['a'], folderId: 'inbox' }, { messageIds: [] }, { messageIds: Array(21).fill('a') },
    { folderId: 'inbox', top: 50 }, { folderId: 'inbox', filter: 'x', search: 'y' }, { messageIds: ['a'], top: 3 },
    { folderId: 'inbox', maxChars: 0 }, { folderId: 'inbox', bogus: 1 }]) {
    await assert.rejects(readMailText(bad, g, 80000), ToolError, JSON.stringify(bad));
  }
});

test('Graph errors surface as tool errors', async () => {
  const graph = async () => ({ status: 400, body: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } });
  await assert.rejects(readMailText({ folderId: 'inbox', filter: 'bad' }, graph, 80000), /BadRequest: Invalid filter clause/);
});

test('Safe Links show the real domain; image alt text is dropped; linked images become labels', () => {
  const sl = 'https://na01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://www.fedex.com/track?id=1') + '&data=abc';
  const t = cleanText(`[FedEx] [Messaging icon]\nTrack it<${sl}>\n[https://images.x.com/logo.png]\n[View role]<${sl}>\nDone.`);
  assert.strictEqual(t, 'Track it [link: fedex.com]\nView role [link: fedex.com]\nDone.');
});

test('line-packed trailing footer (no blank lines) is removed', () => {
  const body = 'Graziela sent you a message about the role and would like a reply this week if you have time to chat.\n' +
    'View message<https://x.com/m>\nThis email was intended for J (CEO)\nLearn why<https://x.com/w>\nYou are receiving Messages digest emails.\nUnsubscribe<https://x.com/u>';
  assert.strictEqual(cleanText(body), 'Graziela sent you a message about the role and would like a reply this week if you have time to chat.\nView message [link: x.com]');
});

test('footer block starting above the midpoint is removed whole', () => {
  const body = 'Short note from Graziela.\nView message<https://x.com/m>\nThis email was intended for J\nLearn why<https://x.com/w>\n' +
    'You are receiving Messages digest emails.\nUnsubscribe<https://x.com/u> · Help<https://x.com/h>\n© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085. LinkedIn and the LinkedIn logo are registered trademarks.';
  assert.strictEqual(cleanText(body), 'Short note from Graziela.\nView message [link: x.com]');
});
