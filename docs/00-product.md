# Coldlyne

> Status: under construction. A hub for every prospecting channel (ten), run from Claude or ChatGPT through an MCP server that acts and sends on its own wherever an API allows.

## 1. What it does

**The promise: you prospect by asking Claude or ChatGPT.** Coldlyne is an MCP server (Model Context Protocol) with real agency: an assistant connected to it finds the companies and people a business should reach, gathers how to reach them, drafts every step on every channel, schedules one sequence per prospect, reads and sorts the replies, and reports what each step and each channel brought in. The web app shows everything the assistant did and lets a member take any of it over by hand. **On every channel Coldlyne reaches through an API, the assistant sends on its own** (the owner's choice, 2026-11-03), within the workspace's limits; a workspace can switch to approving every step first. Where no API may be used for it, Coldlyne prepares the step and a member does it.

1. **Prospects.** French companies and their directors from the public company registry, or a CSV, or by hand. Every prospect and every contact detail keeps where it came from.
2. **Contact details.** The assistant reads a prospect's company site and public profiles and proposes the professional address, the published phone numbers and the LinkedIn, Instagram, Facebook and X profiles, each with the page it was found on; you confirm. The postal address is the registered office's, from the registry. Nothing is guessed, and nothing is bought.
3. **Sequences.** One sequence per campaign, step by step across channels (an email, a LinkedIn message two days later, a call…), with merge fields. The assistant drafts each step from public facts (the email's opening line, the SMS, the letter, the call script and the voicemail script, the messages) and schedules them; a workspace that approves first sees them in batches, in the conversation or in the app.
4. **Ten channels, two kinds of step.**
   - *Sent by Coldlyne, through an API:* **email** from the workspace's own mailboxes, Google Workspace (Gmail's API) or any SMTP mailbox, within a daily cap, a sending window and a ramp-up, spaced out, after the sending domain's SPF, DKIM and DMARC are checked (never through a transactional service such as Resend or Postmark: their terms forbid cold email); **SMS** through a provider the workspace connects, on weekdays in office hours; **letters** through a print-and-post service the workspace connects, which prints, envelopes and posts each one to the registered office; **WhatsApp** through the WhatsApp Business Platform, only with people who agreed to be contacted there (Meta's rule), such as a prospect who replied and gave their number.
   - *Done by a member, prepared by Coldlyne:* **calls**, placed from the app through a telephony provider the workspace connects (or from the member's own phone), with a script; **voicemail drops**: the member records the campaign's message once, and when a call lands on voicemail one click leaves it; **LinkedIn, Instagram, Messenger and X** messages, and a first **WhatsApp** message to someone who hasn't agreed to the Business API. They land in each member's list for the day with the text ready and a link that opens the conversation; the member sends from their own account (or calls) and records the outcome (sent, voicemail left, call back, meeting, not interested). These platforms forbid writing automatically to people who asked for nothing, and accounts get suspended.
5. **Replies.** Email replies read from the mailbox (Gmail threads, or IMAP), SMS and WhatsApp replies from their providers, replies on the other channels (a letter answered by email or phone included) recorded by the member in one click. A reply on any channel, a bounce or an opt-out stops the whole sequence for that prospect. The assistant sorts replies: interested, not now, opt-out, auto-reply.
6. **Figures.** Per campaign, per step, per channel and per day: prospects, sent, bounced, letters posted, calls answered, voicemails left, replied, interested, opted out. Exposed through the MCP server and an API that other apps can read.

   `GET /api/v1/figures?days=30`, `Authorization: Bearer cl_…`, a key made on the keys screen, or through an assistant for an owner or an admin. `days` is 1 to 365. Counts only: no names of people, no addresses. It names the workspace the key opens (`workspace`: its id and name), so an app can tell one key from another, and `daily` is what it needs to measure each stage per day: `prospects` by list, `sent` by sequence and channel (what was on a sequence: not tests, not replies by hand), `signals` by sequence, channel and kind, `interest` by sequence. Each signal and each prospect counts for one sequence: the one that wrote the message it answers, else the last to write to that address; for interest, the last the prospect joined. So adding sequences up gives the workspace. Interest has no date of its own: it counts on the day the prospect last changed. Days follow Europe/Paris, and a day with nothing has no row. The period starts `days` days before the moment asked, so its first day may be cut short: read a day or two more than needed.

## 2. Rules it keeps

- **French and EU B2B prospecting (CNIL, GDPR).** Writing to professionals about their work is allowed without prior consent when every email says who sends it, why the person is written to and where their data comes from, and offers a one-click way out that is honoured at once. Coldlyne puts this in every email's footer and in a `List-Unsubscribe` header (RFC 8058), keeps a workspace-wide suppression list (people and domains), and never writes again to anyone on it.
- **Calls and SMS.** Professionals are called and texted about their work only. Each SMS says who sends it and ends with a way to stop (STOP); a STOP, like an opt-out on any channel, puts the person on the suppression list for every channel.
- **Voicemail.** A message is only left during a call a member placed. Dropping one without a call ("ringless" voicemail), like any automated calling system, needs the person's prior consent under article L34-5 of the CPCE, even between professionals, so Coldlyne never does it; nor does it place calls with a synthetic voice.
- **Letters.** Each letter says who sends it, why the person is written to, where their address comes from and how to object (a short address and a QR code to the opt-out page); an objection, by any means, puts the person on the suppression list for every channel.
- **Platforms' terms.** LinkedIn, Instagram, Messenger and X forbid automated messages to people who asked for nothing, and their APIs don't allow them; WhatsApp allows them only through its Business Platform with people who agreed. Coldlyne prepares, a member sends. No scraping of logged-in pages, no browser automation.
- **The assistant's limits.** Every MCP tool runs as the signed-in member, inside their workspace, with the same rules as the app: caps, windows, the suppression list and the legal footer can't be bypassed by a prompt. By default the assistant sends on its own on the API channels; a workspace setting makes every step wait for a member's approval instead. Destructive tools ask for confirmation.
- **Registry opt-outs.** A company that refused commercial use of its data (`opposition_diffusion_commerciale` in the registry) is never prospected.
- **Sending reputation.** A separate sending domain is recommended (not the business's main domain); new mailboxes ramp up over weeks; caps are per mailbox; no open tracking pixel by default.
- **What isn't prospecting stays out.** Reading a mailbox or a calendar sees everything in it. Coldlyne keeps only what concerns someone the workspace reached out to, by their address or by the message they answer; the rest is dropped and never stored. A STOP counts whoever sends it. What people write (replies) and what websites say reaches the assistant as data written by strangers, never as instructions.
- **Provenance.** Each prospect, address, draft and email says where it came from and who or what made it (a member, an agent, an import).
- **Tenants apart.** Every row carries its workspace; Postgres row-level security keeps workspaces apart (section 7); mailbox and provider credentials are stored encrypted per workspace, never in environment variables.

## 3. How it is built

- Next.js 16 (App Router), TypeScript strict, Tailwind 4; Postgres (Neon, Frankfurt) through Drizzle; Better Auth (Google or a password with a mailed proof of the address, or only a company's OpenID Connect provider); Vitest against an in-process Postgres (PGlite); deployed on Vercel (fra1).
- Layers: `domain` (pure rules: sequences, caps, templates) < `application` (use cases) < `infrastructure` (database, registry API, mail and SMS providers) < `app` (pages, actions, the MCP server). Small single-purpose functions, clear names, comments that say why.
- **MCP first.** Every use case is an MCP tool as well as a screen, built on the same application function, so the assistant can do whatever a member can. The server is remote (streamable HTTP at `/api/mcp`), signs members in with OAuth, and is listed for Claude (web, desktop, Claude Code) and ChatGPT as a connector. Tools, as they land: `search_registry`, `find_contacts`, `draft_sequence`, `schedule_sequence`, `todays_tasks`, `read_replies`, `suppress`, `campaign_figures`.
- **The thinking is the assistant's** (confirmed by the owner, 2026-11-03). Drafting and sorting happen in the member's own Claude or ChatGPT, on their subscription; the app itself runs no model, only the scheduled work (sending, posting, stopping on a reply).
- **Providers per workspace.** Mailboxes, the SMS, print-and-post, telephony and WhatsApp Business providers are connected by each workspace, their credentials stored encrypted. Coldlyne's own mail (sign-in links, notifications, contact@coldlyne.com) goes through Resend, which never carries prospecting.
- **Connections.** Every connectable service is one entry in a catalogue (`domain/connectors`), with what it lets the assistant do and how it is authorized, and one adapter (`infrastructure/connectors`) behind a port per capability (`application/ports`). A connection is checked against its service before it is saved; its secrets are typed on Coldlyne's own page, never in a conversation, and sealed with AES-256-GCM under the instance's `COLDLYNE_SECRETS_KEY`. What services post or report becomes one kind of record, the signal; a STOP or a bounce puts the address on the suppression list as it arrives.
- Sending and reply checks run on a schedule (Vercel cron), a few prospects at a time, so a cap or a reply is never overshot.

## 4. Editions

One open-source core, which can be deployed as a hosted service or as a company's own instance:

| Edition | Repository | Runs at | Database |
|---|---|---|---|
| The core, open source (AGPL-3.0), self-hostable on Vercel and Neon | `Coldlyne/coldlyne` (public) | where whoever installs it runs it | theirs |
| The hosted SaaS: sign-up, plans and billing, customers kept apart | `Coldlyne/coldlyne-cloud` (public fork of the core) | app.coldlyne.com | its own database, in Frankfurt |
| A company's own instance | a private copy of the core | its own address | its own database |

Work lands in the core first. The cloud fork pulls it (`git pull upstream main`, or GitHub's "Sync fork") and adds what only the hosted version needs; a private instance gets it pushed as is. Each deployment's migrations run against its own database.

## 5. Connections

Decided 2026-11-04. "Connect" means a workspace links its own account, except where noted.

| What for | Services |
|---|---|
| **Assistants** (they connect to Coldlyne's MCP server, by OAuth) | Claude (web, desktop, Code), ChatGPT, Le Chat, any MCP client |
| **Where prospects come from** | Built in, no account: the French registry (recherche-entreprises), BODACC's announcements (each one can start a campaign: "every holding created this week"), CSV files, company websites. Connected: INSEE Sirene, INPI's national register, Google Sheets |
| **Email** (send and read replies) | Google Workspace, Microsoft 365, any SMTP and IMAP mailbox |
| **SMS** | Brevo, OVHcloud, smsmode |
| **Letters** | Merci Facteur, Maileva (La Poste) |
| **Calls** | Twilio Voice (calls from the app and the one-click voicemail drop), Aircall, Ringover |
| **WhatsApp** | WhatsApp Business Platform (Meta's Cloud API) |
| **Meetings** (a booked meeting counts as a result) | Google Calendar, Outlook calendar, Cal.com, Calendly |
| **Where results go** | HubSpot, Pipedrive, Sellsy, Axonaut, noCRM.io, folk; Slack; signed outgoing webhooks (n8n, Make, Zapier); an API with keys that other apps read |
| **Sign-ups** | The business's site posts each sign-up to a signed address, which credits it |
| **Deliverability** | Built in: SPF, DKIM, DMARC and MX checks. Connected: Google Postmaster Tools, and Vercel, Cloudflare and OVHcloud DNS to set a sending domain's records |
| **The hosted edition** (Coldlyne's own accounts, not a workspace's) | Stripe for billing, Resend for its own mail |

What is true of these connections today (2026-11-04): each adapter is checked by tests against each provider's documented answers, and only signing in through an OpenID Connect provider and the Sirene lookup have run against a real account; the assistant can use the sources, CRMs, alerts, DNS and read what comes back. A member can do the same from the screens: each connection's page tries what it is for (a test email or alert, a read now, a check), and the deliverability page checks a domain, publishes its records through a connected DNS and shows its spam rate. A list imports from a connected sheet and sends its people to a connected CRM, where the same note is never added twice; a connected source can be asked about a company from its page. What is asked rather than posted (mailboxes, calendars, incoming SMS) is read every hour, and again before anything goes out. The hosted edition's Stripe billing waits on the plans (milestone 12).

Points of attention:

- **Cold SMS.** The CNIL allows B2B prospecting, but Brevo, OVHcloud and smsmode ask for prior consent in their own terms, so an account can be suspended even when the prospecting is legal. A named SMS sender can't be answered: only STOPs come back.
- **INPI.** Its technical documents have reusers commit not to use personal data for prospecting, so its data informs a message and never supplies who to contact; people come from the registry.
- **Google.** Gmail's read scope is restricted and needs verification for public use; an external app still in Testing gets refresh tokens that expire after 7 days. An instance used only by its own organization avoids both with an Internal app.

## 6. Sequences

Left out because they break a rule above: LinkedIn automation, warm-up networks, a contact database with credits, visitor tracking.

- **What runs.** A sequence is steps across channels, each with a delay and a condition (always; after a call that did or didn't connect; after a refused address, to try another channel). It can be changed while it runs: what has left stays as it left, the rest follows.
- **A run** (Vercel cron, every 15 minutes) reads what came back first, so a reply stops the next message rather than races it, then gives whoever is due their step. A sequence nobody is left on finishes by itself, and someone added later starts it again.
- **A job with nothing to do doesn't wake the database.** The 15-minute run needs a running sequence, the hourly read a connected mailbox or calendar, the daily watch a watch. Whether they do is kept in the platform's cache, and whatever starts or stops one clears it at once; it also refreshes once a day, in case something changed by hand. A self-hosted instance running several copies needs a shared cache for this, or a change waits for that refresh. Two runs can't send the same message: it is claimed before the provider is called, and one that never reported back waits for a person rather than risk writing twice.
- **What stops it.** A reply, a booked meeting, a sign-up or an opt-out stops that person on every sequence, and everyone else at their company, now and on later sequences. A bounce stops them unless a step is written for it. An auto-reply stops nothing.
- **What a mailbox may send.** A cap per mailbox (40 a day by default) reached over weeks: 10 a day at first, 5 more every 3 days. What's left today spreads over what's left of the window, three at most per run. Mailboxes share people, and a thread stays in one. A mailbox is paused, and its owner told, at 5% bounces or 10% opt-outs over 7 days from 20 sends; only a member resumes it.
- **What a launch needs.** A sender (a legal name and postal address), someone on it, a connection for each channel Coldlyne sends, and SPF and DMARC on each mailbox's domain (DKIM too where its selector is known). None of this can be waived.
- **What each message carries.** Email: who writes, why this person, where the data comes from, a signed one-click way out (`List-Unsubscribe`, RFC 8058) that works without an account. A letter says the same. An SMS names its sender, and its provider adds the STOP.
- **Who decides.** By default the assistant launches and sends once a member has said yes in the conversation; its launch and approval tools are marked destructive, so clients ask. A workspace can require a member's approval of each launch and message. Only a member changes that, on the Settings page: no tool reaches it.
- **Replies.** One conversation per person, across channels, with what it came to: interested, not now, not interested, wrong person. A member can answer from the same mailbox, and note an answer given elsewhere.
- **The list for the day.** Calls and platform messages, ready to do, each saying how it ended; the sequence carries on from that, with a call's summary kept.
- **Brief.** What the business targets, offers, proves, sounds like and avoids, read by assistants at the start of a conversation, in Claude or ChatGPT alike.
- **Watchlists.** Every morning, BODACC's announcements narrowed by what the registry says of each company go on a list, and the workspace hears about it. Free, unlike buying signals: new companies and new directors, not funding or job changes. A run reads up to 300 companies, at the pace the registry allows, and says so when there are more.

## 7. Several companies

Decided 2026-11-05: the first version is multi-company. One install hosts many companies, each walled off, and one account can belong to several. In the code and on the screens a company using Coldlyne is a workspace (*espace*), since `company` already means a prospect's company.

- **What separates them.** Every row carries its workspace and row-level security keeps the rest out (section 2). Nothing is shared between workspaces: a new one starts with no brief, no mailbox, no list and no exclusion. The scheduled jobs already run across all of them. Being in a workspace is what opens it, and it is read from the database on every page and every assistant call, so someone taken out is out on their next click.
- **On the screens.** A browser is in one workspace at a time, remembered by a cookie. The cookie is only a preference: it opens nothing, and a forged or stale one falls back to the member's first workspace. The switcher next to the member's name shows where they are, and switching goes home, since a list's page belongs to the workspace just left. Someone with one workspace who can't start another sees no switcher at all. Two tabs share the cookie: a form left open in one tab acts in the workspace the browser is in by then.
- **Starting one.** An address in `COLDLYNE_ADMINS` starts workspaces, the first or another, from the switcher, and enters the new one. Everyone else only joins: an invited member can't start a workspace, and someone with an account and no workspace is told to ask for an invitation. The hosted edition's sign-up (milestone 12) will have to widen this.
- **Team.** The Settings page lists a workspace's members and their roles. Owners and admins invite by address (as admin or member), cancel an invitation, remove someone or change their role. Admins run the team but not its owners: only an owner names, changes or removes an owner. Nobody can remove or demote the last owner, and anyone else may leave. Roles only govern the team for now: the rest of a workspace is open to all its members.
- **Someone leaving.** Their calls and messages still to do, the sequences that would give them more, and word of a connection failing go to the workspace's oldest owner, or they would stall where nobody sees them. What they did stays in their name. What they connected stays connected: a mailbox they linked keeps sending until an owner disconnects it, and an API key they made keeps working until someone revokes it. Both belong to the workspace.
- **Invitations.** An invitation is good for one address, for 14 days, once; inviting the address again replaces it. Only a hash of its token is kept, as for API keys. The link goes by Coldlyne's own mail; without `RESEND_API_KEY`, or if the mail fails, the screen shows it to copy, once. Opening the link asks someone signed out to sign in and brings them back; it then asks the invited address to confirm, since mail scanners open links and nothing should change on opening one. Another address, an expired link and a used link each get a clear message that names nobody.
- **Getting an account.** While Coldlyne is private, an address with a live invitation may get an account like an address in `COLDLYNE_ADMINS`: with a password, proved by the mailed link, or through an identity provider that has verified the address. Everyone else stays refused.
- **The assistant.** A token belongs to a member, so one connection covers all their workspaces. There is no current workspace to forget about, because a hidden switch could send email from the wrong company: with several, every tool takes a `workspace` argument (an id or the exact name) and a call without one is refused with a list of their names, so the assistant asks. `list_workspaces` names them. A name that doesn't exist and a workspace that isn't theirs get the same refusal, so it never says a workspace exists. The assistant is told to confirm which workspace before anything that writes to real people. With one workspace, none of this shows: no argument, nothing to ask.
- **Links from an assistant.** The screens use the browser's workspace, not the assistant's. So with several, a link from a tool (where to connect a mailbox, where to approve a sequence) goes through `/workspace/<id>`, which enters that workspace, if it is theirs, then opens the page.
- **Who grants access.** No tool invites, removes or changes members. Like the approval setting, access stays with a member at the screen, because replies and websites can carry instructions.
- **API keys.** Only owners and admins make or revoke them, on the keys screen or through their assistant: `list_api_keys`, `create_api_key` and `revoke_api_key` call the same application functions, which refuse anyone else, and only they see the list through a tool. Every key reads figures and nothing else. Since a key opens a workspace's figures and replies and websites can carry instructions, an assistant is told to make one only when the member asked in that conversation, never because a reply or a page says so, to revoke one only once the member said yes, and never to put a key into a record or a message. A key's row says who made it, when, and when it was last used. Revoking deletes the row, so it leaves nothing behind, and the list only ever holds live keys.

## 8. Milestones

1. **Foundation:** sign in, a workspace, its members, row-level security, the checks, the deploy.
2. **MCP server and connections:** OAuth sign-in for Claude and ChatGPT, the tool registry, the connection catalogue with its adapters and screens; every later milestone ships its tools with its screens.
3. **Prospects:** lists; registry search (activity codes, legal forms, place, size, age; directors and their other companies); CSV import; suppression list.
4. **Contact details:** the assistant reads a prospect's company site and profiles and proposes addresses, numbers and profiles with their page; confirm or reject.
5. **Sequences:** multichannel sequences and templates; drafts for every step; the approval queue.
6. **Email:** mailboxes (Gmail, SMTP), domain checks, caps, window and ramp-up, the scheduler, the unsubscribe page and header, the legal footer.
7. **Replies:** reading replies and bounces, sorting them, stopping sequences, the replies inbox.
8. **Figures:** per step, per channel and per day, through the MCP server and the API.
9. **Calls and messages:** each member's list for the day (calls through a telephony provider with scripts, outcomes and voicemail drops; LinkedIn, WhatsApp, Instagram, Messenger and X messages with their links); a reply recorded on any channel stops the sequence.
10. **SMS and letters:** an SMS provider and a print-and-post service per workspace, STOP handling, the office-hours window, letters to the registered office with their objection address.
11. **WhatsApp Business:** the WhatsApp Business Platform per workspace, its approved message templates, only with people who agreed.
12. **Selling it:** sign-up for other companies, plans and billing.
