# TELES ADS - Telegram Mini App SaaS Platform

TELES ADS is a bundled Telegram Mini App for selling advertising services to Forex, Crypto, and Binary trading Telegram channels — now with **Teles Agent**, a built-in AI assistant powered by OpenRouter free models.

## Deploy on Railway (1-click flow)

1. Create a Railway project.
2. Add a PostgreSQL database service.
3. Deploy this repo as the web service.
4. Set the required environment variables (see below).
5. Railway runs `node setup-db.js` automatically before app startup through `railway.toml`.
6. Register the Telegram webhook after Railway gives you the public service URL:

```bash
APP_URL=https://egatusad.com node setup-webhook.js
```

> Once your custom domain is attached in Railway, set `APP_URL=https://egatusad.com` and re-run the webhook setup.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. On Railway, set this to `${{Postgres.DATABASE_URL}}`. |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from BotFather. |
| `PORT` | Yes | Port to listen on. Railway sets this automatically. |
| `OPENROUTER_API_KEYS` | For AI | Comma-separated OpenRouter key pool. `OPENROUTER_API_KEY` remains supported for one key. |
| `NVIDIA_API_KEYS` | AI fallback | Comma-separated NVIDIA API key pool. `NVIDIA_API_KEY` remains supported for one key. |
| `OPENROUTER_MODELS` | Optional | Comma-separated OpenRouter model list distributed across its key pool. |
| `NVIDIA_MODELS` | Optional | Comma-separated NVIDIA model list. Defaults to `meta/llama-3.1-8b-instruct`. |
| `AI_REQUEST_TIMEOUT_MS` | Optional | Per-attempt timeout from 3 to 45 seconds. Defaults to 15 seconds. |
| `ADMIN_TELEGRAM_ID` | Optional | Telegram user ID for admin access. Defaults to `7049127887`. |
| `APP_URL` | Optional | Public app URL. Defaults to `https://egatusad.com`. |
| `AUTO_SETUP_WEBHOOK` | Optional | Keeps the Telegram webhook pointed at `APP_URL` on startup. Set to `false` only when managed externally. |
| `AGENT_MONITOR_INTERVAL_MS` | Optional | Campaign milestone polling interval. Defaults to 15 minutes and has a 60-second minimum. |

## Teles Agent 🤖

The built-in AI assistant. It knows the platform, live package pricing from the database, and gives channel-growth advice.

- **In the bot:** any plain message in a private chat gets an AI reply. Also `/agent`, `/ask <question>`, `/clear`.
- **In the Mini App:** the floating TELES AI logo opens the chat widget (API: `POST /api/agent/chat`).
- **Persistent memory:** bot conversations survive app restarts when PostgreSQL is configured; `/clear` removes saved memory.
- **Channel intelligence:** `/copy <public channel>` samples public posts, estimates view rate and budget, and creates a reviewable campaign brief. Metrics are explicitly presented as estimates.
- **Campaign operations:** `/health` scores active campaign delivery, while the background monitor sends deduplicated 25/50/75/100% milestone updates.
- **Payment invoices:** submitting valid crypto payment details records the invoice, generates a PDF receipt, and sends it to the campaign owner's Telegram chat.
- **Human handoff:** `/human` creates a support ticket containing the user's request.
- **Multi-provider failover:** requests rotate through the OpenRouter key pool. Key-specific failures try another key; an OpenRouter network or server outage switches immediately to NVIDIA. OpenRouter defaults to `openrouter/free`, which selects from its currently available free models. NVIDIA defaults to the lightweight hosted NIM model `meta/llama-3.1-8b-instruct`.

Package member targets accept exact values (`5000`, `5,000`, `2.5k`) and ranges
(`3k–5k`). A range uses its upper value as the campaign/report target. Invalid or empty
targets are rejected instead of silently falling back to 2,000 members.

## Branding & Images

| File | Used for |
|---|---|
| `public/images/logo.jpg` | Loading screen logo (shown while the app boots) |
| `public/images/avatars/avatar-1.jpg … avatar-9.jpg` | User profile avatars — each user gets a random one; tapping the avatar in Profile opens a picker to choose another |
| `public/images/avatar.png` | Fallback avatar |
| `public/favicon.png` | Browser tab icon |

Replace any of these files (keeping the same names) to rebrand.

## Bot Commands

User commands:
- `/start` - Open the TELES ADS platform.
- `/agent` - Chat with Teles Agent AI.
- `/ask <question>` - Quick one-shot AI answer.
- `/copy <channel>` - Analyze a public Telegram channel and build a campaign brief.
- `/health` - Check the health of active campaigns.
- `/human [reason]` - Create a human-support handoff.
- `/clear` - Reset your AI conversation.
- `/status` - Check campaign status.
- `/packages` - View advertising packages.
- `/support` - Get help and support.
- `/website` - Visit egatusad.com.
- `/help` - List all commands.

Admin commands:
- `/teles` - Open admin panel.
- `/broadcast <message>` - Send a message to all users.
- `/stats` - Platform statistics (users, campaigns, revenue).
- `/copilot` - Show prioritized campaign, lead, and support operations.

## Docker

```bash
docker build -t teles-ai .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host/db" \
  -e TELEGRAM_BOT_TOKEN="your_bot_token" \
  -e OPENROUTER_API_KEYS="sk-or-v1-key-one,sk-or-v1-key-two" \
  -e NVIDIA_API_KEYS="nvapi-key-one,nvapi-key-two" \
  -e PORT=3000 \
  teles-ai
```

## Project Structure

```text
server.cjs                    Bundled Express server
teles-agent.cjs               Teles Agent — bot and Mini App integration
teles-ai-client.cjs           OpenRouter/NVIDIA credential rotation and failover
teles-invoice.cjs             Payment recording, PDF invoice generation, and Telegram delivery
public/index.html             Static app entry point
public/teles-enhancements.js  Avatar picker + AI chat widget
public/images/                Logo + avatars
public/assets/                Bundled frontend JS/CSS
setup-db.js                   PostgreSQL schema and seed setup
setup-webhook.js              Telegram webhook registration helper
package.json                  Node scripts and dependencies
Dockerfile                    Railway/Docker runtime image
railway.toml                  Railway build and deploy config
```

## Notes

- This repo contains a production bundle, not the original source tree.
- The database setup is idempotent and runs on every Railway deploy before the server starts.
- Static files are served from `public/`.
- The AI assistant works without any paid API — OpenRouter free-tier models only.
