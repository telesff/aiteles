"use strict";
/**
 * TELES AGENT — OpenRouter AI module for TELES ADS
 * ------------------------------------------------
 * Free-model AI assistant integrated into the Telegram bot and Mini App.
 *
 * Env vars:
 *   OPENROUTER_API_KEY   Required for AI replies (get one free at https://openrouter.ai/keys)
 *   OPENROUTER_MODELS    Optional comma-separated model override list
 *   APP_URL              Public app URL (default https://telesads.com)
 *
 * Exposes:
 *   handleUpdate(ctx)  -> Promise<boolean>  Telegram webhook hook (true = handled)
 *   apiChat(req, res, deps)                 Express handler for POST /api/agent/chat
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const APP_URL = process.env.APP_URL || "https://telesads.com";
const AGENCY_TG = "https://t.me/TelesAds";

// Fallback chain of OpenRouter FREE models — first one that answers wins.
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
];
const MODELS = (process.env.OPENROUTER_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CHAIN = MODELS.length ? MODELS : DEFAULT_MODELS;

// ---------------------------------------------------------------------------
// Conversation memory (per chat, in-process)
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 16; // max messages kept per chat
const MEMORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CHATS = 500;
const conversations = new Map(); // chatId -> { messages: [], touched: ts }

function getHistory(chatId) {
  const entry = conversations.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.touched > MEMORY_TTL_MS) {
    conversations.delete(chatId);
    return [];
  }
  return entry.messages;
}

function pushHistory(chatId, role, content) {
  let entry = conversations.get(chatId);
  if (!entry) {
    // basic LRU eviction
    if (conversations.size >= MAX_CHATS) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, v] of conversations) {
        if (v.touched < oldestTs) {
          oldestTs = v.touched;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) conversations.delete(oldestKey);
    }
    entry = { messages: [], touched: Date.now() };
    conversations.set(chatId, entry);
  }
  entry.messages.push({ role, content });
  if (entry.messages.length > HISTORY_LIMIT) {
    entry.messages.splice(0, entry.messages.length - HISTORY_LIMIT);
  }
  entry.touched = Date.now();
}

function clearHistory(chatId) {
  conversations.delete(chatId);
}

// ---------------------------------------------------------------------------
// Package cache for the system prompt (refreshed every 5 minutes)
// ---------------------------------------------------------------------------
let pkgCache = { text: "", ts: 0 };

async function packagesSummary(deps) {
  if (Date.now() - pkgCache.ts < 5 * 60 * 1000 && pkgCache.text) return pkgCache.text;
  try {
    if (deps && deps.db && deps.packages) {
      const rows = await deps.db.select().from(deps.packages);
      const active = rows.filter((p) => p.active !== false);
      if (active.length) {
        pkgCache = {
          ts: Date.now(),
          text: active
            .map((p) => {
              let feats = [];
              try { feats = JSON.parse(p.features || "[]"); } catch {}
              return `- ${p.name}: $${p.price}${p.originalPrice ? ` (was $${p.originalPrice})` : ""}${p.members ? `, ${p.members} members` : ""}${p.popular ? " [MOST POPULAR]" : ""}${feats.length ? `. Includes: ${feats.join(", ")}` : ""}`;
            })
            .join("\n"),
        };
        return pkgCache.text;
      }
    }
  } catch (err) {
    console.error("Teles Agent: failed to load packages:", err.message);
  }
  return pkgCache.text || "- Best Package: $199\n- Recommended Package: $359 [MOST POPULAR]\n- Luxury Package: $599";
}

async function systemPrompt(deps) {
  const pkgs = await packagesSummary(deps);
  return `You are Teles Agent, the official AI assistant of TELES ADS (${APP_URL}) — a Telegram advertising agency that grows Forex, Crypto, and Binary trading Telegram channels with real, targeted members.

WHAT TELES ADS OFFERS:
${pkgs}

PLATFORM FEATURES: targeted ad campaigns across premium trading channels, real-time analytics dashboard, campaign progress tracking, referral rewards, support tickets, VIP status for top clients.

HOW TO BUY: users open the Mini App (${APP_URL}), pick a package, submit their channel link, and the campaign starts after review. Support: ${AGENCY_TG} or /support.

YOUR STYLE:
- Friendly, sharp, and concise — this is Telegram chat, keep answers short (under 200 words unless asked for detail).
- Use a few fitting emojis, never walls of them.
- You may use simple formatting: **bold**, bullet lists.
- Help with: choosing packages, channel growth strategy, marketing advice for trading channels, platform questions, general questions.
- If asked about prices or packages, use the exact package data above.
- If a user wants to purchase or has a billing problem, direct them to the Mini App or ${AGENCY_TG}.
- Never invent features TELES ADS does not have. Never promise specific results or guaranteed profits.
- Politely refuse anything illegal or harmful.`;
}

// ---------------------------------------------------------------------------
// OpenRouter call with model fallback
// ---------------------------------------------------------------------------
async function callOpenRouter(messages) {
  if (!OPENROUTER_KEY) {
    return {
      ok: false,
      text: "🤖 Teles Agent is not configured yet. The admin needs to set the OPENROUTER_API_KEY environment variable (free keys at openrouter.ai).",
    };
  }
  let lastErr = "";
  for (const model of MODEL_CHAIN) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": APP_URL,
          "X-Title": "Teles Agent",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });
      if (!res.ok) {
        lastErr = `${model} -> HTTP ${res.status}`;
        continue; // rate-limited / unavailable — try next model
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, text, model };
      lastErr = `${model} -> empty response`;
    } catch (err) {
      lastErr = `${model} -> ${err.name === "AbortError" ? "timeout" : err.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  console.error("Teles Agent: all models failed:", lastErr);
  return {
    ok: false,
    text: "😔 Teles Agent is a bit overloaded right now. Please try again in a minute!",
  };
}

async function generateReply(chatId, userText, deps) {
  const messages = [
    { role: "system", content: await systemPrompt(deps) },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];
  const result = await callOpenRouter(messages);
  if (result.ok) {
    pushHistory(chatId, "user", userText);
    pushHistory(chatId, "assistant", result.text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Telegram helpers (self-contained — safe HTML)
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert the model's light markdown to Telegram-safe HTML. */
function mdToTelegramHtml(text) {
  let t = escapeHtml(text);
  t = t.replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, "$1<i>$2</i>");
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(/^\s*[-*]\s+/gm, "• ");
  return t;
}

async function tgSend(chatId, html, replyMarkup) {
  if (!BOT_TOKEN) return;
  // Telegram hard limit is 4096 chars — chunk long replies.
  const chunks = [];
  let rest = html;
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;
    try {
      const res = await fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // HTML parse failure fallback: resend as plain text
        payload.text = chunks[i].replace(/<[^>]+>/g, "");
        delete payload.parse_mode;
        await fetch(`${TG_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Teles Agent: sendMessage failed:", err.message);
    }
  }
}

async function tgTyping(chatId) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`${TG_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Static texts
// ---------------------------------------------------------------------------
const AGENT_INTRO = `🤖 <b>Teles Agent — Your AI Growth Assistant</b>

I'm the official AI of TELES ADS, powered by cutting-edge AI. Ask me anything:

📦 Which package fits your channel
📈 Growth &amp; marketing strategies for trading channels
💡 How the platform works
❓ Any general question

Just type your message — no command needed. I remember our conversation.

<i>Use /clear to reset our chat anytime.</i>`;

function helpText(isAdmin) {
  let t = `📖 <b>TELES ADS — All Commands</b>

🚀 /start — Open the platform
🤖 /agent — Chat with Teles Agent AI
❓ /ask &lt;question&gt; — Quick one-shot AI answer
🧹 /clear — Reset your AI conversation
📊 /status — Your campaign status
📦 /packages — View advertising packages
🎫 /support — Help &amp; support center
🌐 /website — Visit telesads.com
📖 /help — This list

💬 <b>Tip:</b> in this private chat, any plain message is answered by Teles Agent AI.`;
  if (isAdmin) {
    t += `

🔐 <b>Admin</b>
/teles — Admin panel
/broadcast &lt;msg&gt; — Message all users
/stats — Platform statistics`;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Main Telegram hook
// ---------------------------------------------------------------------------
/**
 * ctx: { text, chatId, userId, update, adminId, db, users, campaigns, packages }
 * Returns true when this module handled the update.
 */
async function handleUpdate(ctx) {
  try {
    let { text, chatId, userId, update } = ctx;
    if (!chatId || !text) return false;
    // Normalize "/cmd@BotName args" -> "/cmd args" (Telegram group syntax)
    if (text.startsWith("/")) text = text.replace(/^(\/[a-zA-Z0-9_]+)@\S+/, "$1");
    const isPrivate = update?.message?.chat?.type === "private";
    const isAdmin = ctx.adminId !== undefined && userId === ctx.adminId;
    const deps = { db: ctx.db, packages: ctx.packages };

    // ---- /agent -------------------------------------------------------
    if (text === "/agent") {
      await tgSend(chatId, AGENT_INTRO, {
        inline_keyboard: [
          [{ text: "🚀 Open Platform", web_app: { url: APP_URL } }],
          [{ text: "🌐 Visit Agency", url: AGENCY_TG }],
        ],
      });
      return true;
    }

    // ---- /ask <question> ---------------------------------------------
    if (text === "/ask" || text.startsWith("/ask ")) {
      const q = text.replace(/^\/ask\s*/, "").trim();
      if (!q) {
        await tgSend(chatId, "❓ Usage: <code>/ask How do I grow my crypto channel?</code>");
        return true;
      }
      await tgTyping(chatId);
      const r = await generateReply(chatId, q, deps);
      await tgSend(chatId, r.ok ? mdToTelegramHtml(r.text) : escapeHtml(r.text));
      return true;
    }

    // ---- /clear ---------------------------------------------------------
    if (text === "/clear") {
      clearHistory(chatId);
      await tgSend(chatId, "🧹 Conversation cleared! Teles Agent has a fresh memory now.");
      return true;
    }

    // ---- /help ----------------------------------------------------------
    if (text === "/help") {
      await tgSend(chatId, helpText(isAdmin));
      return true;
    }

    // ---- /website -------------------------------------------------------
    if (text === "/website") {
      await tgSend(
        chatId,
        `🌐 <b>TELES ADS Official Website</b>\n\n👉 ${APP_URL}\n\nExplore packages, book a strategy call, and grow your channel!`,
        {
          inline_keyboard: [
            [{ text: "🌐 Open Website", url: APP_URL }],
            [{ text: "🚀 Open Platform", web_app: { url: APP_URL } }],
          ],
        }
      );
      return true;
    }

    // ---- /stats (admin) ---------------------------------------------------
    if (text === "/stats") {
      if (!isAdmin) {
        await tgSend(chatId, "⛔ This command is restricted to admins only.");
        return true;
      }
      try {
        const users = ctx.db && ctx.users ? await ctx.db.select().from(ctx.users) : [];
        const campaigns = ctx.db && ctx.campaigns ? await ctx.db.select().from(ctx.campaigns) : [];
        const active = campaigns.filter((c) => c.status === "active").length;
        const pending = campaigns.filter((c) => c.status === "pending").length;
        const completed = campaigns.filter((c) => c.status === "completed").length;
        const revenue = campaigns.reduce((s, c) => s + (Number(c.price) || 0), 0);
        const delivered = campaigns.reduce((s, c) => s + (c.membersDelivered || 0), 0);
        await tgSend(
          chatId,
          `📊 <b>TELES ADS — Platform Stats</b>\n\n👥 Users: <b>${users.length}</b>\n📢 Campaigns: <b>${campaigns.length}</b>\n  🟢 Active: ${active}\n  🟡 Pending: ${pending}\n  ✅ Completed: ${completed}\n💰 Total revenue: <b>$${revenue.toLocaleString()}</b>\n📈 Members delivered: <b>${delivered.toLocaleString()}</b>\n🤖 AI chats in memory: ${conversations.size}`
        );
      } catch (err) {
        await tgSend(chatId, `⚠️ Could not load stats: ${escapeHtml(err.message)}`);
      }
      return true;
    }

    // ---- Plain text in private chat → AI reply ---------------------------
    if (isPrivate && !text.startsWith("/")) {
      await tgTyping(chatId);
      const r = await generateReply(chatId, text, deps);
      await tgSend(chatId, r.ok ? mdToTelegramHtml(r.text) : escapeHtml(r.text));
      return true;
    }

    return false; // not ours — let the existing bot routing handle it
  } catch (err) {
    console.error("Teles Agent handleUpdate error:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mini App HTTP API — POST /api/agent/chat  { message, history? }
// ---------------------------------------------------------------------------
// Light in-memory rate limit so public traffic can't drain the OpenRouter quota.
const RATE_LIMIT = 20; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute per IP
const rateBuckets = new Map(); // ip -> { count, windowStart }

function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    rateBuckets.set(ip, b);
  }
  b.count++;
  if (rateBuckets.size > 5000) {
    // prune stale buckets
    for (const [k, v] of rateBuckets) {
      if (now - v.windowStart > RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return b.count > RATE_LIMIT;
}

async function apiChat(req, res, deps) {
  try {
    const ip = (req.headers && (req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.ip || "unknown";
    if (rateLimited(ip)) {
      res.status(429).json({ error: "Too many requests — slow down a little!" });
      return;
    }
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const trimmed = message.trim().slice(0, 4000);
    const past = Array.isArray(history)
      ? history
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          )
          .slice(-HISTORY_LIMIT)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      : [];
    const messages = [
      { role: "system", content: await systemPrompt(deps) },
      ...past,
      { role: "user", content: trimmed },
    ];
    const result = await callOpenRouter(messages);
    res.json({ reply: result.text, ok: result.ok, agent: "Teles Agent" });
  } catch (err) {
    console.error("Teles Agent apiChat error:", err);
    res.status(500).json({ error: "Teles Agent is unavailable right now." });
  }
}

module.exports = { handleUpdate, apiChat };
