# Coldlyne

Prospecting from Claude or ChatGPT: an MCP server that finds the companies and people a business should reach, prepares every step on ten channels (email, SMS, letters, calls, voicemail drops, LinkedIn, WhatsApp, Instagram, Messenger, X) and sends on its own wherever an API allows, runs one sequence per prospect, stops when they answer, and says what each step brought in. See [docs/00-product.md](docs/00-product.md).

```bash
pnpm install
cp .env.example .env.local   # then fill it in
pnpm db:migrate
pnpm dev
```

Checks before committing: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`.

## Connecting an assistant

Coldlyne's MCP server is at `/mcp`. Add that address to Claude, ChatGPT or any MCP client as a remote connector: the client registers itself, you sign in and approve it, and it acts inside your workspace with the workspace's rules. If you belong to several workspaces, one connection covers them all and the assistant says which one on every call.

## Running your own

Beyond the database, an instance needs:

- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, and `COLDLYNE_ADMINS` for who may sign up and start workspaces. Anyone else joins by invitation, from a workspace's Settings page: see [section 7 of the spec](docs/00-product.md#7-several-companies).
- `COLDLYNE_SECRETS_KEY` (`openssl rand -base64 32`), which seals every connection's credentials. Keep it safe: without it they can't be opened, and members have to connect again.
- A way for members to sign in, one of:
  - your company's identity provider, any OpenID Connect server (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_NAME` for the button), with `<your address>/api/auth/callback/oidc` as its redirect address. It must vouch for each address (`email_verified`), since `COLDLYNE_ADMINS` and invitations go by the address, and it is then the only way in;
  - a Google OAuth app (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), with `<your address>/api/auth/callback/google` as a redirect address;
  - addresses and passwords (`COLDLYNE_PASSWORD_SIGN_IN=true`), which needs `RESEND_API_KEY`: sign-in stays closed until a mailed link proves the address.
- For Gmail, Google Calendar, Google Sheets and Postmaster Tools, that Google OAuth app with `<your address>/api/connections/callback` as a redirect address. Without it, those connectors don't appear on your instance; SMTP and IMAP mailboxes need no app.
- For Outlook mailboxes and calendars, a Microsoft Entra app (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`) with the same `/api/connections/callback` address. Without it, those connectors don't appear either.
- `CRON_SECRET`, which Vercel's cron sends to `/api/cron/send` (every 15 minutes: whoever is due gets their step), `/api/cron/sync` (hourly: mailboxes and calendars) and `/api/cron/watch` (daily: watchlists). Elsewhere, call them on that schedule with `Authorization: Bearer <secret>`.
- Optionally `RESEND_API_KEY`, for Coldlyne's own mail to its members (needed for passwords; without it, an invitation's link is shown to copy). It never carries prospecting.

Everything else (mailboxes, SMS, letters, telephony, WhatsApp, CRMs, DNS) is connected per workspace from the Connections page, where each service says what to do in its console. See [section 5 of the spec](docs/00-product.md#5-connections).

## License

Coldlyne is free software under the [GNU Affero General Public License v3.0](LICENSE): run it, study it, change it and share it; if you offer a modified version to others over a network, publish your changes under the same license. The hosted version runs at [app.coldlyne.com](https://app.coldlyne.com).
