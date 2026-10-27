---
name: email-management
description: Use when the user asks to triage, clean up or work through their inbox (or several mailboxes), or to set up, see or change their email rules. Runs a one-time setup interview that saves the user's triage rules to Claude's memory, then a two-phase triage pass that applies them. Uses the microsoft-365 skill for Microsoft 365 / Outlook mailboxes.
---

# Email management

This skill works through the user's mail with them, using **their own triage rules**.

| File | What it is | Who changes it |
|---|---|---|
| This file | The process | Fixed |
| `example-rules.md` | **The exact form of the user's rules file**, filled with example rules | Fixed; it is the template |
| `interview.md` | How to run the setup interview that produces the user's rules | Fixed |
| Memory file **`email-triage-rules`** | The user's own rules, in the form of `example-rules.md` | Claude, only when the user agrees |

For mailbox mechanics, use the mailbox's own skill: `microsoft-365` for Microsoft 365 / Outlook.

Long conversations lose detail. **Re-read this file and the user's rules in full before every triage pass**, and follow them as written.

## Step 0: is setup done?

At the start of any request covered by this skill, look in your memory for **`email-triage-rules`**.

- **Found:** setup is done. Go to the triage pass, or to the change the user asked for.
- **Not found:** run the setup interview in `interview.md` before anything else. Setup is done when the rules file is saved to memory and you have read it back to the user.
- **Memory is unavailable** (you can't save to memory, or the user has turned it off): tell the user their rules can't be kept between chats without memory. On Team and Enterprise plans an owner turns memory on for the organisation; on other plans the user turns on *Generate memory from chats* in Settings → Memory. Don't run the interview until memory works.

## The rules file

The memory file `email-triage-rules` always has exactly the sections and format of `example-rules.md`: the same headings in the same order. The core rules at the top are kept as written; every other rule is one dated line. Don't add sections, merge rules into prose, or summarise. When you read it, apply it as written.

## Changing the rules

The rules change only when the user says so.

- When the user corrects a disposition or states a preference, show the exact line you would add or change, in the file's format, and ask.
- When they agree, update `email-triage-rules` **in place**: change that one line (or add it under the right heading, with today's date), leave every other line as it is, and show the user the line as saved.
- Never add or change a rule on your own. Never keep an email preference anywhere else in memory; it belongs in the rules file.
- If the user asks to see their rules, show the file exactly as stored. If they ask to start over, run the interview again and replace the file once they approve the new one.

## Several mailboxes

If the user has more than one mailbox, agree the order with them (usually the one needing the most action first). Finish one mailbox completely before starting the next. Never mix messages from different mailboxes in one table. A rule applies to every mailbox unless it names one.

## A triage pass, in two phases

**Phase 1: sort.** Agree every disposition with the user before anything moves.

1. List the **whole** inbox, not just what arrived since last time. Messages left from earlier passes are re-checked: a reply may have been sent or a date passed.
2. Read each message's body (`read-mail-text` for Microsoft 365) and classify it under the user's rules. Decide from the body, never from the sender or subject alone.
3. Present a table with one row per message: sender, subject, the rule that applies, and the action. State the count check: N messages in the inbox, N rows. If they don't match, find the missing ones before presenting.
4. Go through the table with the user until every disposition is right. A correction that should hold next time is a rule change (see above).
5. Carry out the agreed actions. Messages whose action is "keep live" stay in the inbox.

**Phase 2: work what's left with the user.**

6. Go through the kept messages together. For each, the user decides what happens; you carry it out. A reply goes out only after the user approves the exact draft.
7. Report the tally, and list each message still in the inbox with what it needs. Then move to the next mailbox.

## Operating mode

Only when the user asks. Never on your own initiative and never on a schedule. Never send anything without the user's confirmation of the exact draft, except where the user's rules record a standing permission they gave for that exact case.
