# OptionBrains WhatsApp Automation Service

The production path is:

`ob-research → Gateway → Official Meta Cloud API`

`Meta webhook → Gateway → Typebot → Meta Cloud API`

Evolution API remains available under an optional Docker profile for experiments and compatibility. It is not used for production message delivery or customer conversations.

## Capabilities

- Authentication OTP templates
- Utility and marketing template messages
- Customer-service text inside Meta's 24-hour window
- Typebot conversations with numeric menu replies
- Inbound webhook deduplication and read receipts
- `STOP` / `UNSUBSCRIBE` opt-out and `START` opt-in
- Redis-backed campaigns, retries, delivery status, and consent enforcement
- API integration for `ob-research`

## Start

```powershell
Copy-Item .env.example .env
# Fill Meta credentials and generate strong local secrets.
docker compose up -d --build

# Seed the local starter bot.
Get-Content .\scripts\seed-typebot.sql -Raw |
  docker compose exec -T postgres psql -U watsapp -d watsapp

# Local HTTPS webhook tunnel.
.\scripts\cloudflare-tunnel.ps1 -ApplyServerUrl
```

Configure Meta's callback as `<PUBLIC_BASE_URL>/webhook/meta`, use
`WA_BUSINESS_TOKEN_WEBHOOK` as its verify token, and subscribe to `messages`.
Quick-tunnel URLs change after restarts; production must use a fixed HTTPS domain.

## DigitalOcean

[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/Avisekh-OptionBrains/watsappapi/tree/main)

The blueprint is `.do/deploy.template.yaml`. It creates the gateway, Typebot editor, Typebot preview, and Redis in Bangalore. Postgres is the `DATABASE_URL` you enter on that screen. Before you create the app, replace every `replace-me` value with the matching value from your local `.env`.

## Customer conversation

The bundled Typebot public ID is `ob-support`.

- First customer message starts a conversation.
- `hi`, `hii`, `hello`, `menu`, or `help` restarts the menu.
- Customers can reply with `1`, `2`, or `3`; the gateway maps the number to the Typebot choice.
- `#EXIT` closes the current support chat.
- `STOP` records a marketing opt-out.
- `START` restores marketing consent.

Edit and publish flows at http://localhost:3001. The viewer runs at
http://localhost:3002.

## Service API

All `/v1/*` routes require either:

`Authorization: Bearer <SERVICE_API_KEY>`

or:

`x-service-key: <SERVICE_API_KEY>`

Core routes:

- `GET /health`
- `POST /v1/otp/send`
- `POST /v1/messages/template`
- `POST /v1/messages/text`
- `POST /v1/consents`
- `GET /v1/consents/:phone`
- `GET /v1/handoffs/:phone`
- `PATCH /v1/handoffs/:phone`
- `POST /v1/campaigns`
- `GET /v1/campaigns/:id`
- `POST /v1/typebot/start`
- `POST /v1/typebot/status`
- `GET|POST /webhook/meta`

### OTP

```json
{
  "phone": "+9198XXXXXXXX",
  "otp": "123456"
}
```

### Record promotional consent

```json
{
  "phone": "+9198XXXXXXXX",
  "optedIn": true,
  "source": "website",
  "purpose": "OptionBrains offers and research updates"
}
```

### Marketing campaign

The Meta template must already be approved as `MARKETING`. Recipients without
active consent are rejected before queueing.

```json
{
  "name": "Weekly offer",
  "templateName": "weekly_offer",
  "language": "en_US",
  "category": "MARKETING",
  "phones": ["+9198XXXXXXXX"],
  "components": []
}
```

## `ob-research`

Set:

```env
WATSAPP_API_URL=http://localhost:3100
WATSAPP_SERVICE_KEY=<same value as SERVICE_API_KEY>
```

Meta tokens stay only in this service.

## Optional Evolution profile

Start it only when explicitly needed:

```powershell
docker compose --profile evolution up -d evolution-api
```

Set `EVOLUTION_ENABLED=1` only if inbound Meta events must also be forwarded to
Evolution.

## Production requirements

- Replace the quick tunnel with a fixed HTTPS hostname.
- Set `WHATSAPP_APP_SECRET` to enforce `X-Hub-Signature-256`.
- Store secrets in the deployment secret manager.
- Use approved Meta templates and preserve proof of marketing consent.
- Respect opt-outs, Meta messaging limits, quality rating, and template pacing.
