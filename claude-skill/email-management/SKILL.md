---
name: email-management
description: Use when the user asks to triage, clean up or work through their inbox (or several mailboxes) end to end. The top-level process for a triage pass; it uses the user's triage rules (triage-rules.md in this skill) and the skill for each mailbox, such as microsoft-365.
---

# Email management

The process for working through the user's mail on request. It carries the **process** only. How to work each mailbox lives in that mailbox's skill (for Microsoft 365, `microsoft-365`). How to classify each message lives in `triage-rules.md`, in this skill's folder.

Long conversations lose detail. **Re-read this skill and `triage-rules.md` in full before every triage pass**, and follow them as written.

## The pieces

- **Mailbox skills.** One per kind of mailbox. Use `microsoft-365` for a Microsoft 365 / Outlook mailbox through the M365 Claude Relay connector. Load the one you need when you start that mailbox.
- **Triage rules** (`triage-rules.md`). The user's own classification policy: which kinds of mail are kept, archived, filed, deleted or handed elsewhere. It starts as a template and grows as the user corrects you.

## The process is fixed; the rules are the user's

Don't change this process. The rules file changes over time, **but only with the user's explicit consent**: when the user corrects a disposition or states a preference, propose the exact wording to add or change in `triage-rules.md` and change it only when they agree. Never add rules on your own, and never let a remembered preference contradict the rules file. Where you can't edit the skill's files yourself (for example in the Claude apps), give the user the complete updated `triage-rules.md` to save and upload again.

## Several mailboxes

If the user has more than one mailbox, agree the order with them (usually the one needing the most action first). Finish one mailbox completely before starting the next. Never mix messages from different mailboxes in one table.

## A triage pass, in two phases

**Phase 1: sort.** Agree every disposition with the user before anything moves.

1. List the **whole** inbox, not just what arrived since last time. Messages left from earlier passes are re-checked: a reply may have been sent or a date passed.
2. Read each message's body (`read-mail-text` for Microsoft 365) and classify it under `triage-rules.md`. Decide from the body, never from the sender or subject alone.
3. Present a table with one row per message: sender, subject, category, and the action that category calls for. State the count check: N messages in the inbox, N rows. If they don't match, find the missing ones before presenting.
4. Go through the table with the user until every disposition is right.
5. Carry out the agreed actions. Messages whose action is "keep live" stay in the inbox.

**Phase 2: work what's left with the user.**

6. Go through the kept messages together. For each, the user decides what happens; you carry it out. A reply goes out only after the user approves the exact draft.
7. Report the tally, and list each message still in the inbox with what it needs. Then move to the next mailbox.

## Operating mode

Only when the user asks. Never on your own initiative and never on a schedule. Never send anything without the user's confirmation of the exact draft, except where `triage-rules.md` records a standing permission the user gave for that exact case.
