#!/usr/bin/env node
/**
 * TELES ADS — Telegram Webhook Setup
 * Run: node setup-webhook.js
 * Requires: TELEGRAM_BOT_TOKEN and APP_URL environment variables
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}
if (!APP_URL) {
  console.error("❌ APP_URL is not set. Example: https://egatusad.com");
  process.exit(1);
}

const WEBHOOK_URL = `${APP_URL.replace(/\/$/, "")}/api/telegram/webhook`;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function setup() {
  console.log(`Setting webhook to: ${WEBHOOK_URL}`);
  const res = await fetch(`${API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: WEBHOOK_URL, allowed_updates: ["message"] }),
  });
  const data = await res.json();
  if (data.ok) {
    console.log("✅ Webhook registered successfully!");
  } else {
    console.error("❌ Failed:", data.description);
    process.exit(1);
  }
}

setup().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
