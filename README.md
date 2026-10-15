# wa-gateway

One WhatsApp Business number (Meta Cloud API) shared by several websites — OptionBrains, TradePod and any future site. Runs on **Cloudflare Workers** with D1 (state) and Queues (campaigns). No servers, Docker, Redis or Typebot.

What it does:

- **OTP** — login codes via the approved AUTHENTICATION template.
- **Messages** — utility / marketing templates and in-window text for each site.
- **Campaigns** — bulk template sends through a Cloudflare Queue, with consent checks and per-recipient delivery tracking.
- **Consent** — per-site marketing opt-in plus a WhatsApp-wide STOP / START.
- **Bot** — a native WhatsApp menu for every site: catalog (plans, portfolios, hosting...), email-code sign-in with a one-tap website link, account status, help, and handoff to a person. Customers pick the brand when more than one site has a bot.
  - The whole catalog is reachable: long categories get **Next page / Previous** rows, and when a site has more categories than fit the menu the last row opens **All products**.
  - Customers can type a product name ("F&O", "alpha momentum", "catalog"): one clear match opens it, several show a pick list, and products of the other brands on the shared number are offered too.
- **Catalog** — each site's products normalised into one shape and cached in D1 (`GET /v1/catalog`).
- **Events** — inbound messages, delivery receipts and handoff requests are posted to the right site's webhook.
- **Staff dashboard** — `/admin`: live overview, every chat with photos / files, customers asking for a person, take over / assign / reply / send templates and files / hand back to the bot, notes, tags, saved replies, campaigns, reports and alerts.
- **AI answers** — optional Gemini answers to free-text questions from each site's catalog, handing off to staff when unsure.

```
Meta Cloud API ──webhook──▶ wa-gateway (Worker) ──▶ site webhooks (CRM, receipts, handoffs)
                               │   ▲
              D1 + Queue ◀─────┘   └── websites call /v1/* with their own API key
                               │
                               └──▶ site bot APIs (catalog, send-otp, verify-otp, status)
```

## Sites

All websites are configured in the `SITES` secret — a JSON array:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | `optionbrains`, `tradepod`, ... (lowercase, dashes) |
| `name`, `tagline` | yes / no | Shown in the WhatsApp brand picker (24 / 72 chars) |
| `apiKey` | yes | Key the site uses to call this gateway (≥ 24 chars, unique) |
| `publicUrl` | yes | Website origin; bot links must stay on this domain |
| `supportUrl`, `supportEmail` | no | Shown in Help |
| `webhook.url`, `webhook.secret` | no | Where events are posted (`x-webhook-secret` header; secret defaults to `apiKey`) |
| `bot.apiUrl`, `bot.apiKey` | no | Website bot API (Bearer `bot.apiKey`, defaults to `apiKey`). Omit to disable the bot for the site |
| `bot.connector` | no | `standard` (default) or `optionbrains` (legacy ob-research API) |
| `otp.template`, `otp.language`, `otp.copyButton` | no | Defaults `otp_code`, `en_US`, `true` |
| `ai.enabled`, `ai.instructions` | no | Gemini answers for this site (default on when `GEMINI_API_KEY` is set); extra facts / tone |

`DEFAULT_SITE` (in `wrangler.jsonc`) receives messages from customers who never picked a brand.

### Adding a new website

1. Implement the four bot endpoints below on the site (or skip them for OTP/notifications only).
2. Add an entry to `SITES` with a new random `apiKey`, then `npx wrangler secret put SITES`.
3. Give the site two settings: the gateway URL and its `apiKey` (ob-research: `WATSAPP_API_URL`, `WATSAPP_SERVICE_KEY`).

No gateway code changes are needed. The site needs no Meta credentials and no rate limiting of its own for bot calls: the gateway limits sign-in codes per phone and email.

## Website connector contract

Paths are relative to `bot.apiUrl`. Every request carries `Authorization: Bearer <bot.apiKey>`; `phone` is the 10-digit Indian mobile.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /catalog` | — | `{ ok, sections: [{ id, title, description?, items: [{ id, title, subtitle?, body?, priceLabel?, highlights?: string[], action?: { label, path, signIn? } }] }] }` |
| `POST /send-otp` | `{ email, phone }` | `{ ok, isNewUser? }` — email a 6-digit code, create the account on verify if new |
| `POST /verify-otp` | `{ email, phone, otp, next? }` | `{ ok, ux?: { title, body, ctaLabel, ctaUrl } }` — `ctaUrl` should be a one-time login link to `next` |
| `POST /status` | `{ phone, email? }` | `{ ok, status: { found, name?, email?, summary: string[], nextSteps?: [{ id, title, path? }] } }` |

Errors: `{ ok: false, message }` with a 4xx/5xx status. Keep responses under 10 s. Catalog is cached for 10 minutes (`GET /v1/catalog?refresh=1` to refresh). Links the bot sends must be `https` on the site's own domain; anything else falls back to `publicUrl + path`.

## Gateway API

Authenticate with `Authorization: Bearer <site apiKey>` (or `x-service-key`). Phones may be `+91 98765 43210`, `9876543210`, etc.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/otp/send` | `{ phone, otp, templateName?, templateLang?, includeButton? }` |
| POST | `/v1/messages/template` | `{ phone, name, language?, category?: MARKETING\|UTILITY\|AUTHENTICATION, components? }` — MARKETING needs consent |
| POST | `/v1/messages/text` | `{ phone, text }` — only inside the 24 h customer window |
| POST | `/v1/consents` | `{ phone, optedIn, source: website\|checkout\|admin\|whatsapp\|import, purpose? }` |
| GET | `/v1/consents/:phone` | `{ consent, whatsappOptOut }` |
| POST | `/v1/campaigns` | `{ templateName, phones[], language?, components?, category?, requireOptIn?, name? }` → 202 |
| GET | `/v1/campaigns`, `/v1/campaigns/:id`, `/v1/campaigns/:id/recipients?status=&limit=&offset=` | Totals: pending / sent / delivered / read / failed |
| GET | `/v1/handoffs?status=pending`, `/v1/handoffs/:phone` | Customers waiting for a person |
| PATCH | `/v1/handoffs/:phone` | `{ status: pending\|assigned\|resolved, assignedTo? }` — `resolved` turns the bot back on |
| GET | `/v1/catalog` | This site's normalised catalog |
| POST | `/v1/bot/start` | `{ phone }` — send the site menu (alias `/v1/typebot/start`) |
| POST | `/v1/bot/stop` | `{ phone }` — clear the bot conversation |
| GET | `/health` | DB + config check |

## Staff dashboard

Open `https://<gateway>/admin` and sign in with `ADMIN_API_KEY` (shown as "Admin") or a personal key from the optional `STAFF` secret:

```json
[{ "name": "Neha", "key": "<min 24 chars>", "role": "agent" }, { "name": "Arjun", "key": "<min 24 chars>", "role": "admin" }]
```

The name is shown on every reply that person sends. The key stays in the browser tab's session storage only. Roles:

| | agent (default) | admin |
| --- | --- | --- |
| Read chats, reply, send files / templates, take over, assign, hand back, notes, tags | ✓ | ✓ |
| Reports | ✓ | ✓ |
| Create / cancel campaigns, manage quick replies, CSV export, delete others' notes | | ✓ |

Pages:

- **Overview** — last 24 h: active / new chats, customers waiting for help, chats with staff, inbound vs bot (incl. AI) / staff / system / campaign messages, failed deliveries, opt-outs, running campaigns, per-site breakdown.
- **Chats** — every conversation. Tabs: all, needs help, **my chats**, with agent, unread, bot; search; filter by site or tag; **+ New chat** (start a conversation with a template). In a chat:
  - full transcript with photos, documents, voice notes and videos (loaded through the gateway, kept by WhatsApp ~30 days), delivery ticks, staff names, "Bot · AI" answers;
  - composer: ⚡ saved replies (or type `/`), 📎 send a photo / file (16 MB; images 5 MB), 📄 send an approved template (works after the 24 h window), ✨ AI draft (needs `GEMINI_API_KEY`; staff review before sending);
  - **Take over**, **Assign to…** a teammate, **Hand back to bot** (optionally with the menu);
  - ⓘ panel: customer details, marketing consent, **tags** and internal **notes**.
- **Activity** — live feed of every message in and out (filter by author, incl. AI answers).
- **Campaigns** — every campaign with delivered / read rates; click for failures and **Cancel**. Admins create campaigns here: pick a template, fill its blanks with a live preview, choose recipients (paste / CSV upload, customers with a tag, or everyone opted in). Marketing templates always go only to opted-in customers.
- **Reports** — 7 / 30 / 90 days: messages per day chart, first-reply times (average, median, % within 15 min, never answered), per-staff stats, most tapped menu options, most common typed questions, CSV export of messages and customers.
- **Quick replies** — saved answers with `{name}`, `{site}`, `{agent}` placeholders, per site or global.
- **🔔 Alerts** (sidebar toggle, per browser) — sound + desktop notification when someone asks for a person or writes in one of your chats.

Each chat is in one of three modes:

| Mode | Bot | How it gets there |
| --- | --- | --- |
| `bot` | answers | default |
| `needs_help` | quiet unless the customer says hi / menu or taps a button | customer chose "Talk to a person" |
| `agent` | silent | staff pressed **Take over** or sent a reply |

**Hand back to bot** (optionally sending the menu) returns the chat to `bot` and resolves the handoff. Staff modes revert to `bot` automatically after 24 h without staff activity. WhatsApp only allows free text within 24 h of the customer's last message — outside that window the composer is disabled; use a template instead.

Data refreshes by polling every few seconds. Chat history is kept for 180 days. For extra protection put the `/admin*` and `/v1/admin/*` paths behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).

### Alerts outside the dashboard

When a customer asks for a person, the gateway alerts every configured channel, and again if nobody has replied after `ALERT_ESCALATE_MINUTES` (default 10; checked every 5 minutes by cron):

| Channel | Settings |
| --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (secrets) |
| Slack / Discord / Google Chat | `ALERT_WEBHOOK_URL` (incoming webhook, secret) |
| Email via [Resend](https://resend.com) | `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` (comma-separated) |

Set `DASHBOARD_URL` (e.g. `https://wa.optionbrains.com`) so alerts link straight to the chat.

### AI answers (Gemini)

With `GEMINI_API_KEY` set, free-text questions the menu cannot handle ("is the F&O plan good for beginners?") are answered by Gemini using only that site's catalog, support details and the recent conversation. Answers come with **Main menu** / **Talk to our team** buttons. Gemini hands off to staff instead of guessing for account, payment, refund or complaint questions, or when unsure. Guard rails: links to other domains are replaced with the site URL, no personalised financial advice, at most `AI_MAX_PER_HOUR` (default 15) AI answers per customer per hour, menu fallback on any error. Customer messages are sent to Google for these answers.

Per site, add `"ai": { "enabled": false }` to turn it off or `"ai": { "instructions": "Refunds within 7 days. Office hours 10-6 IST." }` to add facts and tone. `AI_ENABLED=0` turns it off everywhere; `GEMINI_MODEL` defaults to `gemini-2.5-flash`. The same key powers the ✨ draft button for staff.

### Admin API

Bearer `ADMIN_API_KEY` or a `STAFF` key. ★ = admin role only.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/admin/me` | Name, role, team, sites, enabled features |
| GET | `/v1/admin/overview?site=` | 24 h stats + waiting customers |
| GET | `/v1/admin/chats?mode=all\|needs_help\|mine\|agent\|unread\|bot&site=&tag=&q=&before=&limit=` | Conversation list + counts |
| GET | `/v1/admin/chats/:phone` | Transcript (with media), consent, open help request, notes; marks read |
| POST | `/v1/admin/chats/:phone/reply` | `{ text }` — takes over the chat; 409 outside the 24 h window |
| POST | `/v1/admin/chats/:phone/media` | multipart `file`, `caption` |
| POST | `/v1/admin/chats/:phone/template` | `{ name, language, values, site?, customerName? }` — also starts new chats |
| POST | `/v1/admin/chats/:phone/takeover` | Pause the bot |
| POST | `/v1/admin/chats/:phone/assign` | `{ to }` — staff name |
| POST | `/v1/admin/chats/:phone/release` | `{ sendMenu? }` — hand back to the bot |
| POST | `/v1/admin/chats/:phone/suggest` | AI draft `{ text }` |
| POST | `/v1/admin/chats/:phone/notes`, DELETE `/v1/admin/notes/:id` | Internal notes |
| PUT | `/v1/admin/chats/:phone/tags` | `{ tags: [] }`; GET `/v1/admin/tags` lists tags with counts |
| GET | `/v1/admin/media/:id` | Streams a photo / file from WhatsApp |
| GET | `/v1/admin/templates?refresh=1` | Approved templates (needs `WHATSAPP_WABA_ID`) |
| GET / POST★ / DELETE★ | `/v1/admin/quick-replies` | Saved replies |
| GET | `/v1/admin/activity?site=&author=&limit=` | Message feed (`author=ai` for AI answers) |
| GET / POST★ | `/v1/admin/campaigns`, GET `/v1/admin/campaigns/:id`, POST★ `/v1/admin/campaigns/:id/cancel` | `{ site, name, templateName, language, values, audience: list\|tag\|opted_in, phones?, tag?, requireOptIn? }` |
| GET | `/v1/admin/reports?days=7&tz=330&site=` | Charts, response times, staff, top questions |
| GET★ | `/v1/admin/export/messages.csv?days=30`, `/v1/admin/export/chats.csv` | CSV export |
| GET | `/v1/admin/staff`, `/v1/admin/catalog` | Team list; every site's catalog |

## Data

Everything lives in one **Cloudflare D1** database (`wa-gateway`, SQLite); campaign sends go through a **Cloudflare Queue**. Nothing else to run.

| Table | What it holds | Kept |
| --- | --- | --- |
| `conversations` | One row per customer: site, name, mode, assigned staff, tags, unread, last message | forever |
| `chat_messages` | Every message in / out with author, staff name, media id, delivery status | 180 days |
| `staff_notes`, `quick_replies` | Internal notes per customer; saved replies | forever |
| `support_requests` | Each "talk to a person": when, first reply time / by, escalation | 1 year |
| `handoffs` | Current handoff per site + customer (site API) | resolved: 30 days |
| `outbound_messages` | Which site sent which message (delivery receipts) | 90 days |
| `campaigns`, `campaign_recipients` | Campaigns and per-recipient status | forever |
| `consents` | Marketing opt-in per site + WhatsApp-wide STOP | forever |
| `bot_sessions`, `phone_sites`, `catalog_cache` | Bot menu position, chosen brand, 10-minute catalog cache | short |
| `processed_messages` | Webhook de-duplication | 7 days |

Photos and files are not copied; WhatsApp keeps them about 30 days and the dashboard streams them on demand.

### Events sent to sites

`POST webhook.url` with `{ event, site, payload, ts }`:

- `whatsapp.crm` — `{ phone, text, messageId, kind: message|opt_in|opt_out, type, interactiveId, profileName }`
- `whatsapp.outbound` — `{ messageId, phone, kind: otp|template|text|media, preview }` (not for campaigns)
- `whatsapp.status` — `{ messageId, phone, status: sent|delivered|read|failed, error, kind, preview }` (not for campaigns)
- `whatsapp.support_handoff` — `{ phone, message, createdAt }`

## Deploy to Cloudflare

```powershell
npm install
npx wrangler login

npx wrangler d1 create wa-gateway          # copy database_id into wrangler.jsonc
npx wrangler queues create wa-campaign
npx wrangler queues create wa-campaign-dlq
npm run db:migrate                         # applies migrations/ to the remote D1

npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put SITES              # paste the one-line JSON array
npx wrangler secret put STAFF              # optional: named dashboard logins
npx wrangler secret put GEMINI_API_KEY     # optional: AI answers + drafts
npx wrangler secret put TELEGRAM_BOT_TOKEN # optional alerts (see "Alerts outside the dashboard")
npx wrangler secret put TELEGRAM_CHAT_ID

npm run deploy
```

Non-secret settings (`WHATSAPP_WABA_ID`, `DASHBOARD_URL`, `GEMINI_MODEL`, `AI_ENABLED`, `ALERT_ESCALATE_MINUTES`, ...) are in `vars` in `wrangler.jsonc`.

Then:

1. **Custom domain** — uncomment `routes` in `wrangler.jsonc` (`wa.optionbrains.com`, zone must be on Cloudflare) and deploy again. The `*.workers.dev` URL also works.
2. **Meta webhook** — WhatsApp → Configuration: callback `https://wa.optionbrains.com/webhook/meta`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`.
3. **Sites** — give each website the gateway URL and its `apiKey` (ob-research: `WATSAPP_API_URL`, `WATSAPP_SERVICE_KEY`).
4. Check `https://wa.optionbrains.com/health` — `warnings` must be empty.

Secrets can also go in one file: copy the values into `.prod.vars` (git-ignored, `KEY=value` lines) and run `npm run secrets:prod`.

### CI / CD (GitHub Actions)

`.github/workflows/ci-cd.yml` runs on every push and pull request: typecheck, tests, dashboard script check and a dry-run Worker build. On `main` it then applies D1 migrations, uploads secrets (optional), deploys and checks `/health`.

One-time setup in GitHub → repository → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template, plus Account → **D1: Edit** and **Queues: Edit** |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | From `npx wrangler whoami` |
| Variable | `DEPLOY_ENABLED` | `true` (deploys are skipped until set) |
| Variable | `GATEWAY_URL` | e.g. `https://wa-gateway.<subdomain>.workers.dev` (health check after deploy) |
| Secret (optional) | `WORKER_SECRETS` | Full contents of `.prod.vars`; uploaded on every deploy so secrets live in one place |

Add required reviewers to the `production` environment if deploys should wait for approval. Changes reach production by merging to `main`; for risky changes open a pull request first so the checks run before merge.

Logs: `npx wrangler tail`. The Workers Paid plan ($5/mo) is recommended for production CPU limits and queue volume.

## Local development

```powershell
cp .dev.vars.example .dev.vars   # fill in values
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test
npm run typecheck
```

`ENVIRONMENT=development` in `.dev.vars` accepts unsigned webhooks so you can post sample Meta payloads to `/webhook/meta`.
