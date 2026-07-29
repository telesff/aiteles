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
APP_URL=https://your-app.up.railway.app node setup-webhook.js
```

> Once your custom domain (telesads.com) is attached in Railway, set `APP_URL=https://telesads.com` and re-run the webhook setup.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. On Railway, set this to `${{Postgres.DATABASE_URL}}`. |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from BotFather. |
| `PORT` | Yes | Port to listen on. Railway sets this automatically. |
| `OPENROUTER_API_KEY` | For AI | Free API key from [openrouter.ai/keys](https://openrouter.ai/keys). Powers Teles Agent. |
| `OPENROUTER_MODELS` | Optional | Comma-separated model override list. Defaults to a chain of free models. |
| `ADMIN_TELEGRAM_ID` | Optional | Telegram user ID for admin access. Defaults to `7049127887`. |
| `APP_URL` | Optional | Public app URL. Defaults to `https://telesads.com`. |

## Teles Agent 🤖

The built-in AI assistant. It knows the platform, live package pricing from the database, and gives channel-growth advice.

- **In the bot:** any plain message in a private chat gets an AI reply. Also `/agent`, `/ask <question>`, `/clear`.
- **In the Mini App:** floating 🤖 button opens the chat widget (API: `POST /api/agent/chat`).
- **Free models with automatic fallback:** if one model is rate-limited, the next one answers. Default chain:
  1. `nvidia/nemotron-3-ultra-550b-a55b:free`
  2. `nvidia/nemotron-3-super-120b-a12b:free`
  3. `google/gemma-4-31b-it:free`
  4. `openai/gpt-oss-20b:free`

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
- `/clear` - Reset your AI conversation.
- `/status` - Check campaign status.
- `/packages` - View advertising packages.
- `/support` - Get help and support.
- `/website` - Visit telesads.com.
- `/help` - List all commands.

Admin commands:
- `/teles` - Open admin panel.
- `/broadcast <message>` - Send a message to all users.
- `/stats` - Platform statistics (users, campaigns, revenue).

## Docker

```bash
docker build -t teles-ai .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host/db" \
  -e TELEGRAM_BOT_TOKEN="your_bot_token" \
  -e OPENROUTER_API_KEY="sk-or-v1-..." \
  -e PORT=3000 \
  teles-ai
```

## Project Structure

```text
server.cjs                    Bundled Express server
teles-agent.cjs               Teles Agent — OpenRouter AI module
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
