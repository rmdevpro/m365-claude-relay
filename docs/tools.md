# Tool reference and recommended Claude permissions

Policy `2026-09-30.5` is **scope-led**: users consent to `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite`; Softeria's `--allowed-scopes` derives the tool surface from those scopes at every container start (every tool whose required scopes are covered; 139 tools for the default list). Scopes are set by the operator (`MS365_MCP_ALLOWED_SCOPES`). Tools are not picked by hand; the only exceptions are tools the relay replaces with better ones: `download-bytes`/`download-bytes-to-file` (excluded; `get-download-url` replaces them) and the three attachment-bridge primitives (hidden; `get-attachment-upload-link` replaces them).

Columns: **Effect** = what the tool does (Softeria's own description, first sentence). **State**: `Allow` (exposed; Always allow in Claude), `Approve` (exposed; Needs approval in Claude), `Hidden` (exposed to the relay only, for the upload bridge), `Off` (not exposed — the scope isn't granted, the tool is work-tenant only, or the relay replaces it with a better tool; the Why says which). 
Principle: anything that leaves the mailbox (sends), destroys data, grants someone else access, or commits the user to something (calendar responses) = Approve. Reads, drafts and reversible edits inside the user's own data = Allow.

## Gate tool

| Tool | Effect | State | Why |
|---|---|---|---|
| get-attachment-upload-link | attaches a file to a **draft** (`messageId`) or a **calendar event** (`eventId`); attaching to an event the user organises makes Outlook send an update to attendees | Allow | same user, draft/event-scoped; skill warns and confirms before uploading to an organiser's event (advisory) |

## Mail

| Tool | Effect | State | Why |
|---|---|---|---|
| add-mail-attachment | internal (upload bridge) — Use this API to create a new Attachment | Hidden | only reachable through get-attachment-upload-link |
| copy-mail-message | Copy a message to a folder within the user's mailbox | Allow | reversible edit inside the user's own data |
| create-draft-email | Create a draft Outlook email message in the signed-in user's Drafts folder | Allow | nothing sent until send-draft-message |
| create-focused-inbox-override | Create an override for a sender identified by an SMTP address | Allow | reversible edit inside the user's own data |
| create-forward-draft | Create a forward draft | Allow | nothing sent until send-draft-message |
| create-mail-attachment-upload-session | internal (upload bridge) — Create an upload session that allows an app to iteratively upload ranges of a file, so as to attach the file to the specified Outlook item | Hidden | only reachable through get-attachment-upload-link |
| create-mail-child-folder | Use this API to create a new child mailFolder | Allow | reversible edit inside the user's own data |
| create-mail-folder | Use this API to create a new mail folder in the root folder of the user's mailbox | Allow | reversible edit inside the user's own data |
| create-mail-rule | Create a messageRule object by specifying a set of conditions and actions | Approve | mail rules can silently forward, move or delete future mail |
| create-outlook-category | Create an outlookCategory object in the user's master list of categories | Allow | reversible edit inside the user's own data |
| create-reply-all-draft | Create a draft to reply to the sender and all recipients of a message in either JSON or MIME format | Allow | nothing sent until send-draft-message |
| create-reply-draft | Create a draft to reply to the sender of a message in either JSON or MIME format | Allow | nothing sent until send-draft-message |
| create-shared-mailbox-draft | POST /users/{user-id}/messages | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-shared-mailbox-forward-draft | Create a forward draft in a shared mailbox without sending | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-shared-mailbox-reply-all-draft | Create a reply-all draft in a shared mailbox preserving thread metadata (conversationId, In-Reply-To, References) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-shared-mailbox-reply-draft | Create a reply draft in a shared mailbox preserving thread metadata (conversationId, In-Reply-To, References) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-focused-inbox-override | Delete an override specified by its ID | Approve | destroys data |
| delete-mail-attachment | Delete a mail attachment | Approve | destroys data |
| delete-mail-folder | Delete the specified mailFolder | Approve | destroys data |
| delete-mail-message | Delete an Outlook email message by its message ID | Approve | B4 decision |
| delete-mail-rule | Delete the specified messageRule object | Approve | destroys data |
| download-bytes | Download binary content from Microsoft Graph and return it as base64 | Off | replaced by get-download-url (one-time link); base64 in the conversation fails for real files |
| forward-mail-message | Forward a message using either JSON or MIME format | Approve | B4 decision |
| forward-shared-mailbox-mail | Forward a message from a shared mailbox preserving full HTML formatting and attachments | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-download-url | Resolve a short-lived, pre-authenticated download URL for Microsoft Graph binary content that exposes one (drive/SharePoint file content) | Allow | read-only |
| get-mail-message | Get a single Outlook email message by its message ID, including full subject, sender, recipients, body, and attachment flags | Allow | read-only |
| get-mail-message-mime | Download the raw MIME source (RFC 5322 .eml content) of an Outlook email message by its message ID | Allow | read-only |
| get-mail-tips | Get the MailTips of one or more recipients as available to the signed-in user | Allow | read-only |
| get-mailbox-settings | Get the user's mailboxSettings | Allow | read-only |
| get-shared-mailbox-message | GET /users/{user-id}/messages/{message-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-focused-inbox-overrides | Get the overrides that a user has set up to always classify messages from certain senders in specific ways | Allow | read-only |
| list-mail-attachments | Retrieve a list of attachment objects | Allow | read-only |
| list-mail-child-folders | Get the folder collection under the specified folder | Allow | read-only |
| list-mail-folder-messages | Get all the messages in the specified user's mailbox, or those messages in a specified folder in the mailbox | Allow | read-only |
| list-mail-folder-messages-delta | Get a set of messages added, deleted, or updated in a specified folder | Allow | read-only |
| list-mail-folders | Get the mail folder collection directly under the root folder of the signed-in user | Allow | read-only |
| list-mail-messages | List, search, and filter Outlook email messages in the signed-in user's mailbox across all folders | Allow | read-only |
| list-mail-rules | Get all the messageRule objects defined for the user's inbox | Allow | read-only |
| list-outlook-categories | Get all the categories that have been defined for a user | Allow | read-only |
| list-shared-mailbox-folder-messages | CRITICAL: When searching emails, the $search parameter value MUST be wrapped in double quotes | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-shared-mailbox-messages | CRITICAL: When searching emails, the $search parameter value MUST be wrapped in double quotes | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-supported-languages | Get the list of locales and languages that are supported for the user, as configured on the user's mailbox server | Allow | read-only |
| list-supported-time-zones | Get the list of time zones that are supported for the user, as configured on the user's mailbox server | Allow | read-only |
| move-mail-message | Move a message to another folder within the specified user's mailbox | Allow | reversible edit inside the user's own data |
| move-shared-mailbox-message | destinationId accepts folder ID or well-known name (inbox, drafts, sentitems, deleteditems, junkemail, archive) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| reply-all-mail-message | Reply to all recipients of a message using either JSON or MIME format | Approve | B4 decision |
| reply-all-shared-mailbox-mail | Reply-all to a message from a shared mailbox preserving full HTML formatting and conversation thread | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| reply-mail-message | Reply to the sender of a message using either JSON or MIME format | Approve | B4 decision |
| reply-shared-mailbox-mail | Reply to a message from a shared mailbox preserving full HTML formatting and conversation thread | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| search-query | POST /search/query | Off | needs a scope the policy does not grant (Calendars.Read, ChannelMessage.Read.All, Chat.Read, Files.Read.All, Mail.Read, People.Read, Sites.Read.All) |
| send-draft-message | Send an existing draft message | Approve | B4 decision |
| send-mail | Send the message specified in the request body using either JSON or MIME format | Approve | B4 decision |
| send-shared-mailbox-draft | Send an existing draft from a shared mailbox | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| send-shared-mailbox-mail | CRITICAL: Do not try to guess the email address of the recipients | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-focused-inbox-override | Change the classifyAs field of an override as specified | Allow | reversible edit inside the user's own data |
| update-mail-folder | Update the properties of mailfolder object | Allow | reversible edit inside the user's own data |
| update-mail-message | Update an existing Outlook email message by its message ID — for example mark it read or unread (isRead), flag it (flag), change its categories, importance, or edit a draft's subject, body, or recipients | Allow | reversible edit inside the user's own data |
| update-mail-rule | Change writable properties on a messageRule object and save the changes | Approve | mail rules can silently forward, move or delete future mail |
| update-mailbox-settings | Enable, configure, or disable one or more of the following settings as part of a user's mailboxSettings: When updating the preferred date or time format for a user, specify it in respectively, the short date or short tim | Approve | changes auto-replies / forwarding-relevant settings |
| update-shared-mailbox-message | PATCH /users/{user-id}/messages/{message-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |

## Calendar

| Tool | Effect | State | Why |
|---|---|---|---|
| accept-calendar-event | Accept the specified event in a user calendar | Approve | B4 decision |
| cancel-calendar-event | This action allows the organizer of a meeting to send a cancellation message and cancel the event | Approve | B4 decision |
| create-calendar | Create a new calendar for a user | Allow | reversible edit inside the user's own data |
| create-calendar-event | Create (schedule) a new calendar event — a meeting or appointment — on the user's calendar | Approve | B4 decision |
| create-my-calendar-permission | Create a calendarPermission resource to specify the identity and role of the user with whom the specified calendar is being shared or delegated | Approve | grants another person access (calendar share/delegate, OneDrive sharing link) |
| create-specific-calendar-event | Create a calendar event on a specific calendar | Approve | B4 decision |
| decline-calendar-event | Decline invitation to the specified event in a user calendar | Approve | B4 decision |
| delete-calendar | Delete a calendar other than the default calendar | Approve | destroys data |
| delete-calendar-event | Removes the specified event from the containing calendar | Approve | B4 decision |
| delete-my-calendar-permission | Delete my calendar permission | Approve | destroys data |
| delete-specific-calendar-event | Delete a specific calendar event | Approve | destroys data |
| dismiss-calendar-event-reminder | Dismiss a reminder that has been triggered for an event in a user calendar | Allow | reminder only |
| find-meeting-times | POST /me/findMeetingTimes | Off | needs a scope the policy does not grant (Calendars.Read.Shared) |
| forward-calendar-event | This action allows the organizer or attendee of a meeting event to forward the meeting request to a new recipient | Approve | leaves the mailbox / visible to others |
| get-calendar-event | Get the properties and relationships of the specified event object | Allow | read-only |
| get-calendar-view | Get the occurrences, exceptions, and single instances of events in a calendar view defined by a time range, from the user's default calendar, or from some other calendar of the user | Allow | read-only |
| get-room | Gets a place cast as a room, returning room-specific properties: displayName, emailAddress (for booking), capacity, building, floorNumber, floorLabel, isWheelChairAccessible, audioDeviceName, videoDeviceName, displayDevi | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-room-list | Gets a place cast as a room list, returning room list properties: displayName, emailAddress, address | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-room-list-room | The place-id is the room list ID or email, and room-id is the specific room ID | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-schedule | POST /me/calendar/getSchedule | Off | needs a scope the policy does not grant (Calendars.Read) |
| get-shared-calendar-view | GET /users/{user-id}/calendarView | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-specific-calendar-event | Get a single event from one of the signed-in user's calendars, addressed by calendar ID and event ID | Allow | read-only |
| get-specific-calendar-view | List the occurrences, exceptions, and single instances of events over a time range, from one of the signed-in user's calendars addressed by calendar ID | Allow | read-only |
| list-calendar-event-instances | The occurrences of a recurring series, if the event is a series master | Allow | read-only |
| list-calendar-events | Get a list of event objects in the user's mailbox | Allow | read-only |
| list-calendar-events-delta | Get a set of event resources that have been added, deleted, or updated in a calendarView (a range of events defined by start and end dates) of the user's primary calendar | Allow | read-only |
| list-calendar-view-delta | Get a set of event resources that have been added, deleted, or updated in a calendarView (a range of events defined by start and end dates) of the user's primary calendar | Allow | read-only |
| list-calendars | Get all the user's calendars (/calendars navigation property), get the calendars from the default calendar group or from a specific calendar group | Allow | read-only |
| list-my-calendar-permissions | The permissions of the users with whom the calendar is shared | Allow | read-only |
| list-room-list-rooms | The place-id is the ID or email address of the room list (from get-room-list) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-shared-calendar-events | GET /users/{user-id}/calendar/events | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-specific-calendar-events | List events from one of the signed-in user's calendars, addressed by calendar ID | Allow | read-only |
| snooze-calendar-event-reminder | Postpone a reminder for an event in a user calendar until a new time | Allow | reminder only |
| tentatively-accept-calendar-event | Tentatively accept the specified event in a user calendar | Approve | B4 decision |
| update-calendar | Update a calendar. 💡 TIP: Updates a calendar's properties | Allow | reversible edit inside the user's own data |
| update-calendar-event | Update an event on the default calendar | Approve | B4 decision |
| update-my-calendar-permission | Update my calendar permission | Approve | grants another person access (calendar share/delegate, OneDrive sharing link) |
| update-place | Updates properties of a place (room, room list, building, floor, section, desk, workspace) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-specific-calendar-event | Update a specific calendar event | Allow | reversible edit inside the user's own data |

## Contacts

| Tool | Effect | State | Why |
|---|---|---|---|
| create-contact-child-folder | Create a new contactFolder as a child of a specified folder | Allow | reversible edit inside the user's own data |
| create-contact-folder | Create a new contactFolder under the user's default contacts folder | Allow | reversible edit inside the user's own data |
| create-contact-in-folder | Add a contact to the root Contacts folder or to the contacts endpoint of another contact folder | Allow | reversible edit inside the user's own data |
| create-outlook-contact | Add a contact to the root Contacts folder or to the contacts endpoint of another contact folder | Allow | reversible edit inside the user's own data |
| delete-contact-folder | Delete contactFolder other than the default contactFolder | Approve | destroys data |
| delete-outlook-contact | Delete a contact | Approve | destroys data |
| get-outlook-contact | Retrieve the properties and relationships of a contact object | Allow | read-only |
| list-contact-folder-child-folders | Get a collection of child folders under the specified contact folder | Allow | read-only |
| list-contact-folder-contacts | Get a contact collection from the default Contacts folder of the signed-in user (.../me/contacts), or from the specified contact folder | Allow | read-only |
| list-contact-folders | Get the contact folder collection in the default Contacts folder of the signed-in user | Allow | read-only |
| list-outlook-contacts | Get a contact collection from the default contacts folder of the signed-in user | Allow | read-only |
| update-contact-folder | Update the properties of contactfolder object | Allow | reversible edit inside the user's own data |
| update-outlook-contact | Update the properties of a contact object | Approve | B4 decision |

## OneDrive

| Tool | Effect | State | Why |
|---|---|---|---|
| copy-drive-item | Copy a drive item. 💡 TIP: Asynchronously copy a file or folder to a new location and/or name | Allow | reversible edit inside the user's own data |
| create-drive-item-preview | Create a drive item preview | Allow | reversible edit inside the user's own data |
| create-drive-item-share-link | Create a link to share a driveItem driveItem | Approve | grants another person access (calendar share/delegate, OneDrive sharing link) |
| create-onedrive-folder | Create a OneDrive folder | Allow | reversible edit inside the user's own data |
| create-upload-session | Create an upload session | Allow | reversible edit inside the user's own data |
| delete-drive-item-permission | Delete a drive item permission | Approve | destroys data |
| delete-onedrive-file | Delete a OneDrive file | Approve | destroys data |
| extract-drive-item-sensitivity-labels | Returns the Microsoft Information Protection (MIP) sensitivity labels assigned to a file | Off | needs a scope the policy does not grant (Files.Read.All) |
| get-drive-delta | Track changes in a driveItem and its children over time | Allow | read-only |
| get-drive-item | All items contained in the drive | Allow | read-only |
| get-drive-root-item | The root folder of the drive | Allow | read-only |
| get-sensitivity-label | Gets a single MIP sensitivity label by id | Off | needs a scope the policy does not grant (SensitivityLabel.Read) |
| list-drive-item-permissions | The set of permissions for the item | Allow | read-only |
| list-drive-item-thumbnails | Collection of thumbnailSet objects associated with the item | Allow | read-only |
| list-drive-item-versions | The list of previous versions of the item | Allow | read-only |
| list-drives | Retrieve the list of Drive resources available for a target User, Group, or Site | Allow | read-only |
| list-folder-files | Return a collection of DriveItems in the children relationship of a DriveItem | Allow | read-only |
| list-sensitivity-labels | Lists Microsoft Information Protection (MIP) sensitivity labels available to the signed-in user | Off | needs a scope the policy does not grant (SensitivityLabel.Read) |
| move-rename-onedrive-item | Move or rename a OneDrive item | Allow | reversible edit inside the user's own data |
| search-onedrive-files | Search the hierarchy of items for items matching a query | Allow | read-only |
| share-drive-item | Send a sharing invitation for a driveItem | Approve | grants another person access (calendar share/delegate, OneDrive sharing link) |
| upload-file-content | The content stream, if the item represents a file | Allow | reversible edit inside the user's own data |

## Excel

| Tool | Effect | State | Why |
|---|---|---|---|
| add-excel-table-rows | Add Excel table rows | Allow | reversible edit inside the user's own data |
| clear-excel-range | Clear an Excel range | Allow | reversible edit inside the user's own data |
| create-excel-chart | Creates a new chart | Allow | reversible edit inside the user's own data |
| create-excel-table | Create a new table. The range source address determines the worksheet under which the table will be added | Allow | reversible edit inside the user's own data |
| delete-excel-range | Delete an Excel range | Approve | destroys data |
| delete-excel-table-row | Delete an Excel table row | Approve | destroys data |
| format-excel-range | Format an Excel range | Allow | reversible edit inside the user's own data |
| format-excel-range-border | Format an Excel range border | Allow | reversible edit inside the user's own data |
| format-excel-range-fill | Format an Excel range fill | Allow | reversible edit inside the user's own data |
| format-excel-range-font | Format an Excel range font | Allow | reversible edit inside the user's own data |
| get-excel-range | Get an Excel range | Allow | read-only |
| get-excel-range-format | Returns a format object, encapsulating the range's font, fill, borders, alignment, and other properties | Allow | read-only |
| get-excel-table | Represents a collection of tables associated with the workbook | Allow | read-only |
| get-excel-used-range | Get an Excel used range | Allow | read-only |
| insert-excel-range | Insert an Excel range | Allow | reversible edit inside the user's own data |
| list-excel-table-rows | The list of all the rows in the table | Allow | read-only |
| list-excel-tables | Represents a collection of tables associated with the workbook | Allow | read-only |
| list-excel-worksheets | Represents a collection of worksheets associated with the workbook | Allow | read-only |
| merge-excel-range | Merge an Excel range | Allow | reversible edit inside the user's own data |
| sort-excel-range | Sort an Excel range | Allow | reversible edit inside the user's own data |
| unmerge-excel-range | Unmerge an Excel range | Allow | reversible edit inside the user's own data |
| update-excel-range | Update an Excel range | Allow | reversible edit inside the user's own data |
| update-excel-table-row | Update an Excel table row | Allow | reversible edit inside the user's own data |

## Users / profile

| Tool | Effect | State | Why |
|---|---|---|---|
| get-current-user | Retrieve the properties and relationships of user object | Allow | read-only |
| get-my-manager | Gets the current user's manager | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-my-profile | [beta] Retrieve the properties and relationships of a profile object for a given user | Allow | read-only |
| get-user-manager | Gets the manager of a specific user by user ID or UPN (email) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-my-direct-reports | Lists users who report directly to the current user | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-my-memberships | Lists all groups, directory roles, and administrative units the current user is a member of | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-relevant-people | Lists people most relevant to the current user, ordered by relevance | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-user-direct-reports | Lists users who report directly to a specific user | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-users | CRITICAL: This request requires the ConsistencyLevel header set to eventual | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| upload-my-profile-photo | Uploads a new profile photo for the signed-in user | Off | needs a scope the policy does not grant (User.ReadWrite) |

## Other (no scope metadata)

| Tool | Effect | State | Why |
|---|---|---|---|
| create-subscription | Creates a webhook subscription for change notifications | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |
| delete-subscription | Deletes a webhook subscription | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |
| get-subscription | Gets a specific webhook subscription by id | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |
| graph-batch | internal (upload bridge) — Combine up to 20 Graph requests into a single HTTP call | Hidden | only reachable through get-attachment-upload-link |
| list-subscriptions | Lists webhook subscriptions owned by the current app/user | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |
| reauthorize-subscription | Reauthorizes a subscription after receiving a 'reauthorizationRequired' lifecycle notification from Microsoft Graph | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |
| update-subscription | Renews a webhook subscription by extending its expiration | Approve | registers a callback URL for change notifications; exposed (no scope needed) — block in Claude if unwanted |

## OneNote

| Tool | Effect | State | Why |
|---|---|---|---|
| create-onenote-notebook | Creates a new OneNote notebook | Off | needs a scope the policy does not grant (Notes.Create) |
| create-onenote-page | Body must be a full HTML document (with <html><head><title>...</title></head><body>...</body></html>) | Off | needs a scope the policy does not grant (Notes.Create) |
| create-onenote-section | Creates a new section in a notebook | Off | needs a scope the policy does not grant (Notes.Create) |
| create-onenote-section-page | Body must be a full HTML document (with <html><head><title>...</title></head><body>...</body></html>) | Off | needs a scope the policy does not grant (Notes.Create) |
| create-sharepoint-site-onenote-notebook | POST /sites/{site-id}/onenote/notebooks | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-site-onenote-section | POST /sites/{site-id}/onenote/notebooks/{notebook-id}/sections | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-site-onenote-section-group-section | POST /sites/{site-id}/onenote/sectionGroups/{sectionGroup-id}/sections | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-site-onenote-section-page | Body must be a full HTML document (with <html><head><title>...</title></head><body>...</body></html>) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-onenote-page | Deletes a OneNote page permanently | Off | needs a scope the policy does not grant (Notes.ReadWrite) |
| delete-sharepoint-site-onenote-page | DELETE /sites/{site-id}/onenote/pages/{onenotePage-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-onenote-notebook-from-web-url | Resolves a OneNote notebook from its web URL (the link a user copies from OneNote / SharePoint / Teams) | Off | needs a scope the policy does not grant (Notes.Read) |
| get-onenote-page-content | GET /me/onenote/pages/{onenotePage-id}/content | Off | needs a scope the policy does not grant (Notes.Read) |
| get-sharepoint-site-onenote-page-content | GET /sites/{site-id}/onenote/pages/{onenotePage-id}/content | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-all-onenote-sections | Lists all sections across all notebooks | Off | needs a scope the policy does not grant (Notes.Read) |
| list-onenote-notebook-sections | GET /me/onenote/notebooks/{notebook-id}/sections | Off | needs a scope the policy does not grant (Notes.Read) |
| list-onenote-notebooks | GET /me/onenote/notebooks | Off | needs a scope the policy does not grant (Notes.Read) |
| list-onenote-pages | Lists all OneNote pages across every notebook and section the user has access to — transverse alternative to walking notebooks → sections → pages | Off | needs a scope the policy does not grant (Notes.Read) |
| list-onenote-section-groups | Lists all OneNote section groups (subfolders inside notebooks that contain their own sections and nested section groups) for the user | Off | needs a scope the policy does not grant (Notes.Read) |
| list-onenote-section-pages | GET /me/onenote/sections/{onenoteSection-id}/pages | Off | needs a scope the policy does not grant (Notes.Read) |
| list-sharepoint-site-onenote-notebook-section-groups | GET /sites/{site-id}/onenote/notebooks/{notebook-id}/sectionGroups | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-onenote-notebook-sections | GET /sites/{site-id}/onenote/notebooks/{notebook-id}/sections | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-onenote-notebooks | GET /sites/{site-id}/onenote/notebooks | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-onenote-section-group-section-groups | GET /sites/{site-id}/onenote/sectionGroups/{sectionGroup-id}/sectionGroups | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-onenote-section-group-sections | GET /sites/{site-id}/onenote/sectionGroups/{sectionGroup-id}/sections | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-onenote-section-pages | GET /sites/{site-id}/onenote/sections/{onenoteSection-id}/pages | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-sharepoint-site-onenote-page-content | PATCH /sites/{site-id}/onenote/pages/{onenotePage-id}/content | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |

## Tasks (To Do / Planner)

| Tool | Effect | State | Why |
|---|---|---|---|
| create-planner-bucket | POST /planner/buckets | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-planner-task | POST /planner/tasks | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-planner-task-message | Posts a message to a Planner task's chat (the modern 'task chat', not the legacy conversationThreadId comment) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-todo-linked-resource | Links a resource to a To Do task | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| create-todo-task | Creates a new task in a Microsoft To Do list | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| create-todo-task-list | Creates a new Microsoft To Do task list (the named buckets shown in the To Do app sidebar) | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| delete-planner-bucket | CRITICAL: Requires If-Match header with ETag from get-planner-bucket (use includeHeaders=true) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-planner-task-message | Deletes a message from a Planner task's chat | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-todo-linked-resource | Removes a linked resource from a To Do task | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| delete-todo-task | DELETE /me/todo/lists/{todoTaskList-id}/tasks/{todoTask-id} | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| delete-todo-task-list | Deletes a Microsoft To Do task list | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| get-planner-bucket | Response includes @odata.etag — required as If-Match for update-planner-bucket and delete-planner-bucket | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-planner-plan | GET /planner/plans/{plannerPlan-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-planner-task | Response includes @odata.etag — save it, required as If-Match header for update-planner-task | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-planner-task-details | Response includes @odata.etag — required for update-planner-task-details | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-todo-task | Returns a single To Do task | Off | needs a scope the policy does not grant (Tasks.Read) |
| list-plan-buckets | GET /planner/plans/{plannerPlan-id}/buckets | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-plan-tasks | Priority is 0-10 (lower = higher priority); | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-planner-task-messages | Lists messages in a Planner task's chat — the modern Planner 'task chat', distinct from the legacy conversationThreadId comments (which live in the M365 group conversation thread) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-planner-tasks | Priority is 0-10 (lower = higher priority); | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-todo-linked-resources | Lists resources linked to a To Do task (emails, URLs, etc.) | Off | needs a scope the policy does not grant (Tasks.Read) |
| list-todo-task-lists | Lists all To Do task lists | Off | needs a scope the policy does not grant (Tasks.Read) |
| list-todo-tasks | Lists tasks in a To Do list | Off | needs a scope the policy does not grant (Tasks.Read) |
| update-planner-bucket | CRITICAL: Requires If-Match header with ETag from get-planner-bucket (use includeHeaders=true) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-planner-task | CRITICAL: Requires If-Match header with the task's @odata.etag value, otherwise returns 412 Precondition Failed | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-planner-task-details | CRITICAL: Requires If-Match header with ETag from get-planner-task-details (use includeHeaders=true) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-todo-task | Updates a Microsoft To Do task | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |
| update-todo-task-list | Renames a Microsoft To Do task list | Off | needs a scope the policy does not grant (Tasks.ReadWrite) |

## Search

| Tool | Effect | State | Why |
|---|---|---|---|
| copilot-retrieve | Retrieval here is semantic/hybrid, unlike search-query/search-onedrive-files/search-sharepoint-sites, which are lexical KQL | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| search-sharepoint-sites | GET /sites | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |

## Teams (work only)

| Tool | Effect | State | Why |
|---|---|---|---|
| add-team-member | POST /teams/{team-id}/members | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| clear-my-presence | Ends the application's presence session for the current user | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| clear-my-user-preferred-presence | Clears any preferred (sticky) presence override set via set-my-user-preferred-presence | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-chat | Creates a new 1:1 or group Teams chat | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-custom-emoji | Uploads a custom Teams emoji for the organization using body: { displayName, contentBytes } | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-online-meeting | Creates a new online meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-team-channel | POST /teams/{team-id}/channels | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-online-meeting | Deletes an online meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-team-channel | DELETE /teams/{team-id}/channels/{channel-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-adhoc-call-transcript-content | Returns the transcript of an ad hoc call as WebVTT with speaker tags and timestamps | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-channel-files-folder | Gets the SharePoint driveItem (folder) that contains the files for a Teams channel | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-channel-message | GET /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-chat | GET /chats/{chat-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-chat-message | GET /chats/{chat-id}/messages/{chatMessage-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-meeting-attendance-report | Gets a specific attendance report with totalParticipantCount, meetingStartDateTime, meetingEndDateTime | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-meeting-recording | Gets metadata for a specific recording: createdDateTime, endDateTime, contentCorrelationId (links recording to its transcript), meetingOrganizer, callId | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-meeting-recording-content | Returns the authenticated meeting recording video bytes in MP4 format | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-meeting-transcript | Gets metadata for a specific transcript: createdDateTime, contentCorrelationId (links transcript to its recording), meetingId, meetingOrganizer | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-meeting-transcript-content | Returns the transcript content in WebVTT format with speaker identification and timestamps | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-my-presence | Gets the current user's presence status | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-online-meeting | Gets a specific online meeting by ID | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-presences-by-user-id | Gets presence for multiple users in a single call | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-team | GET /teams/{team-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-team-channel | GET /teams/{team-id}/channels/{channel-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-user-presence | Gets presence status for a specific user by their user ID or UPN (email) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-virtual-event-webinar | Gets a specific webinar with full details: displayName, description, startDateTime, endDateTime, audience, coOrganizers, presenters, registrationConfiguration, and status | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-adhoc-call-transcripts | Lists transcripts of ad hoc calls (PSTN, 1:1 and group calls) started by the signed-in user | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-channel-message-hosted-contents | Lists hosted-content references (inline images, code snippets) attached to a Teams channel message | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-channel-message-replies | GET /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-channel-messages | GET /teams/{team-id}/channels/{channel-id}/messages | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-channel-tabs | GET /teams/{team-id}/channels/{channel-id}/tabs | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-chat-members | Lists members of a chat | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-chat-message-hosted-contents | Lists hosted-content references (inline images, code snippets) attached to a Teams chat message | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-chat-message-replies | GET /chats/{chat-id}/messages/{chatMessage-id}/replies | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-chat-messages | Lists messages in a chat | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-chats | Lists the signed-in user's chats | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-custom-emojis | Lists the organization's custom Teams emojis, including displayName, createdBy and createdDateTime | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-joined-teams | GET /me/joinedTeams | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-meeting-attendance-records | Lists individual attendance records for a meeting report | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-meeting-attendance-reports | Lists attendance reports for a meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-meeting-recordings | Lists recordings for a meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-meeting-transcripts | Lists available transcripts for a meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-my-associated-teams | Lists Teams the current user is associated with — both joined teams and host teams of shared channels the user is a direct member of | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-my-installed-teams-apps | Lists Teams apps installed in the current user's personal scope (the apps pinned to the user's Teams sidebar / accessible without joining a team or chat) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-online-meetings | Look up a meeting with $filter=JoinWebUrl eq '{url}', using the joinUrl from an event's onlineMeeting property | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-pinned-chat-messages | GET /chats/{chat-id}/pinnedMessages | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-team-channels | GET /teams/{team-id}/channels | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-team-members | GET /teams/{team-id}/members | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-webinar-sessions | Lists sessions for a webinar | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| parse-teams-url | Converts any Teams meeting URL format (short /meet/, full /meetup-join/, or recap ?threadId=) into a standard joinWebUrl | Allow | read-only |
| pin-chat-message | POST /chats/{chat-id}/pinnedMessages | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| remove-team-member | DELETE /teams/{team-id}/members/{conversationMember-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| reply-to-channel-message | Use contentType 'html' in the body — plain text contentType gets mangled by Graph API | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| reply-to-chat-message | Use contentType 'html' in the body — plain text contentType gets mangled by Graph API | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| send-channel-message | Use contentType 'html' in the body — plain text contentType gets mangled by Graph API | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| send-chat-message | Use contentType 'html' in the body — plain text contentType gets mangled by Graph API | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| send-my-activity-notification | Sends a Teams activity feed notification to the current user (the badge + entry in their Activity tab) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| set-channel-message-reaction | POST /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/setReaction | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| set-chat-message-reaction | POST /chats/{chat-id}/messages/{chatMessage-id}/setReaction | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| set-my-presence | Sets the user's presence session as an application | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| set-my-status-message | Sets the user's Teams status message (the free-text note shown next to their name, e.g | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| set-my-user-preferred-presence | Sets the user's preferred (sticky) availability and activity — the value Teams clients display regardless of underlying activity | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| unpin-chat-message | DELETE /chats/{chat-id}/pinnedMessages/{pinnedChatMessageInfo-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| unset-channel-message-reaction | POST /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/unsetReaction | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| unset-chat-message-reaction | POST /chats/{chat-id}/messages/{chatMessage-id}/unsetReaction | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-channel-message | PATCH /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-channel-message-reply | PATCH /teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies/{chatMessage-id1} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-chat-message | PATCH /chats/{chat-id}/messages/{chatMessage-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-online-meeting | Updates an existing online meeting | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-team-channel | PATCH /teams/{team-id}/channels/{channel-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |

## Work only (SharePoint, shared mailboxes, org)

| Tool | Effect | State | Why |
|---|---|---|---|
| add-group-member | Adds a member to a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| add-group-owner | Adds an owner to a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-group | Creates a new group. Required body: { displayName, mailEnabled (bool), mailNickname (no spaces), securityEnabled (bool) } | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-list | Creates a new SharePoint list in a site | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-list-column | Creates a new column on a SharePoint list | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| create-sharepoint-list-item | Creates a new item in a SharePoint list | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-group | Permanently deletes a group and all its associated resources (conversations, files, calendar, planner) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-sharepoint-list-column | Deletes a column from a SharePoint list | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| delete-sharepoint-list-item | Deletes a list item permanently | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-group | Gets a specific group's details: displayName, description, mail, visibility, groupTypes, membershipRule, createdDateTime | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-group-calendar-view | GET /groups/{group-id}/calendarView | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-list-column | Gets a specific column definition by ID, including its full type configuration (choices for choice columns, format for dateTime, etc.) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site | GET /sites/{site-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site-by-path | Resolve a SharePoint site from its server-relative URL | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site-drive-by-id | GET /sites/{site-id}/drives/{drive-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site-item | GET /sites/{site-id}/items/{baseItem-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site-list | GET /sites/{site-id}/lists/{list-id} | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-site-list-item | Add $expand=fields to include actual column values | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| get-sharepoint-sites-delta | GET /sites/delta() | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-group-conversations | Legacy — Microsoft recommends Teams channels instead of group conversations | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-group-events | GET /groups/{group-id}/events | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-group-members | Lists members of a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-group-owners | Lists owners of a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-group-threads | Legacy — Microsoft recommends Teams channels instead of group threads | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-groups | Lists organization groups (Microsoft 365 groups, security groups, distribution lists) | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-list-columns | Lists column definitions for a SharePoint list | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-drives | GET /sites/{site-id}/drives | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-items | GET /sites/{site-id}/items | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-list-items | Add $expand=fields to include actual column values | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| list-sharepoint-site-lists | GET /sites/{site-id}/lists | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| remove-group-member | Removes a member from a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| remove-group-owner | Removes an owner from a group | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| reply-to-group-thread | Legacy — Microsoft recommends Teams channels instead of group threads | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-group | Updates group properties | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-sharepoint-list-column | Updates a column definition | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |
| update-sharepoint-list-item | Updates fields on an existing list item | Off | work-tenant only; not available on personal accounts; Blue Fox decision (needs admin-consented scopes) |

## Other

| Tool | Effect | State | Why |
|---|---|---|---|
| list-trending-insights | Lists documents trending around the current user | Off | needs a scope the policy does not grant (Sites.Read.All) |

## Summary
- 337 tools in Softeria 0.157.0 (+ the gate's upload tool): Allow 95, Approve 36, Hidden 3, Off 203.
- Exposed with the default scopes (policy 2026-09-30.5): 139 (136 visible to Claude + 3 hidden).
