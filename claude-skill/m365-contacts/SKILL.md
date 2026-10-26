---
name: m365-contacts
description: Use for the user's Microsoft 365 / Outlook contacts through the M365 relay connector — finding a contact, reading details, creating, updating or deleting contacts, and contact folders.
---

# Microsoft 365 contacts

The M365 relay connector gives you the signed-in user's own Outlook contacts through Microsoft Graph. Every call runs as that user.

## Tools for the common jobs

| Task | Tool |
|---|---|
| List contacts (default folder) | `list-outlook-contacts` |
| List contacts in a folder | `list-contact-folder-contacts` |
| Read one contact | `get-outlook-contact` |
| Create | `create-outlook-contact` (default folder) or `create-contact-in-folder` |
| Update | `update-outlook-contact` |
| Delete | `delete-outlook-contact` |
| Contact folders | `list-contact-folders`, `list-contact-folder-child-folders`, `create-contact-folder`, `create-contact-child-folder` |

**Finding someone:** there is no reliable server-side search for contacts. List them (raise `$top`, e.g. 200, and follow `@odata.nextLink` if there are more) and match names, addresses and company yourself. Resolve a folder name to its id with `list-contact-folders`.

A saved contact is not the same as someone the user has emailed. If there is no contact, say so; search mail separately if the user wants.

## Updating a contact

Graph **replaces list fields as a whole** on update: email addresses, phone numbers and each address. To change one email, send the complete list including the ones that stay. Read the contact first when existing values matter.

## Ground rules

- Never create, change or delete a contact without the user's confirmation of that exact change.
- Never invent contact details. Take names, addresses and numbers from the source the user points to.
- Notes on a contact can be personal. Include them only when the user asks.
- A 401 means the connector's sign-in expired: ask the user to reconnect. A 403 means the consented scopes don't cover contacts: tell the user.
