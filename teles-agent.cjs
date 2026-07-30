"use strict";
/**
 * TELES AGENT — OpenRouter AI module for TELES ADS
 * ------------------------------------------------
 * Free-model AI assistant integrated into the Telegram bot and Mini App.
 *
 * Env vars:
 *   OPENROUTER_API_KEYS  Comma-separated OpenRouter key pool (singular also works)
 *   NVIDIA_API_KEYS      Comma-separated NVIDIA key pool (singular also works)
 *   OPENROUTER_MODELS    Optional comma-separated OpenRouter model list
 *   NVIDIA_MODELS        Optional comma-separated NVIDIA model list
 *   APP_URL              Public app URL (default https://egatusad.com)
 *
 * Exposes:
 *   handleUpdate(ctx)  -> Promise<boolean>  Telegram webhook hook (true = handled)
 *   apiChat(req, res, deps)                 Express handler for POST /api/agent/chat
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const APP_URL = process.env.APP_URL || "https://egatusad.com";
const AGENCY_TG = "https://t.me/TelesAds";
const LOGO_URL = `${APP_URL.replace(/\/$/, "")}/images/logo.jpg`;
const intelligence = require("./teles-intelligence.cjs");
const persistentStore = require("./teles-store.cjs");
const { createAiClient } = require("./teles-ai-client.cjs");
const flows = new Map();
const aiClient = createAiClient({ appUrl: APP_URL });

/**
 * Convert a package label into an exact campaign member target.
 * Existing packages may use values such as "5,000", "2.5k", or "3k–5k Members".
 * A range uses its upper value as the delivery target.
 */
function parseMemberTarget(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;

  const values = value.match(/\d[\d,.]*(?:\s*[kKmM](?![a-zA-Z]))?/g) || [];
  const parsed = values
    .map((token) => {
      const normalized = token.trim().toLowerCase();
      const multiplier = normalized.endsWith("k")
        ? 1_000
        : normalized.endsWith("m")
          ? 1_000_000
          : 1;
      const numeric = normalized.replace(/[km]$/, "").replace(/,/g, "");
      const result = Number.parseFloat(numeric) * multiplier;
      return Number.isFinite(result) && result > 0 ? Math.floor(result) : null;
    })
    .filter((target) => target !== null);

  return parsed.length ? Math.max(...parsed) : null;
}

async function ensureTelegramWebhook() {
  if (!BOT_TOKEN || process.env.AUTO_SETUP_WEBHOOK === "false") return;
  const webhookUrl = `${APP_URL.replace(/\/$/, "")}/api/telegram/webhook`;
  const response = await fetch(`${TG_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.description || `Telegram returned HTTP ${response.status}`);
  }
  console.log(`Teles Agent: Telegram webhook ready at ${webhookUrl}`);
}

ensureTelegramWebhook().catch((error) => {
  console.error("Teles Agent: webhook setup failed:", error.message);
});

// ---------------------------------------------------------------------------
// Conversation memory (per chat, in-process)
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 16; // max messages kept per chat
const MEMORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CHATS = 500;
const conversations = new Map(); // chatId -> { messages: [], touched: ts }
const hydratedChats = new Set();

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
  hydratedChats.delete(String(chatId));
}

async function hydrateHistory(chatId) {
  const key = String(chatId);
  if (hydratedChats.has(key) || conversations.has(chatId)) return;
  hydratedChats.add(key);
  try {
    const messages = (await persistentStore.loadConversation(chatId))
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string"
      )
      .slice(-HISTORY_LIMIT);
    if (messages.length) {
      conversations.set(chatId, { messages, touched: Date.now() });
    }
  } catch (error) {
    console.error("Teles Agent: failed to hydrate memory:", error.message);
  }
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
              const target = parseMemberTarget(p.members);
              return `- ${p.name}: $${p.price}${p.originalPrice ? ` (was $${p.originalPrice})` : ""}${target ? `, target ${target.toLocaleString()} members` : p.members ? `, ${p.members}` : ""}${p.popular ? " [MOST POPULAR]" : ""}${feats.length ? `. Includes: ${feats.join(", ")}` : ""}`;
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

async function campaignsSummary(deps) {
  if (!deps?.db || !deps?.campaigns || !deps?.userId) {
    return "No signed-in campaign context is available.";
  }
  try {
    const rows = await deps.db.select().from(deps.campaigns);
    const own = rows
      .filter((campaign) => Number(campaign.telegramId) === Number(deps.userId))
      .slice(-5);
    if (!own.length) return "This user has no campaigns yet.";
    return own
      .map(
        (campaign) =>
          `- ${campaign.packageName}: ${campaign.status}; ${Number(campaign.membersDelivered || 0).toLocaleString()} / ${Number(campaign.membersTarget || 0).toLocaleString()} members delivered for ${campaign.channelLink}`
      )
      .join("\n");
  } catch (error) {
    console.error("Teles Agent: failed to load campaign context:", error.message);
    return "Campaign context is temporarily unavailable.";
  }
}

async function systemPrompt(deps) {
  const pkgs = await packagesSummary(deps);
  const campaignContext = await campaignsSummary(deps);
  return `You are Teles Agent, the official AI growth strategist of TELES ADS (${APP_URL}) — a Telegram advertising agency that grows Forex, Crypto, and Binary trading Telegram channels with real, targeted members.

WHAT TELES ADS OFFERS:
${pkgs}

PLATFORM FEATURES: targeted ad campaigns across premium trading channels, real-time analytics dashboard, campaign progress tracking, referral rewards, support tickets, VIP status for top clients.

CURRENT USER CAMPAIGNS:
${campaignContext}

AGENT POWERS:
- Package strategist: recommend the best package from live package data and explain who it fits.
- Campaign auditor: identify weak channel bio, pinned post, offer clarity, trust signals, and conversion risks.
- Growth planner: give a simple 3-step action plan before the user spends.
- Report explainer: translate delivery, member target, reach, clicks, and conversion into plain English.
- Compliance guard: avoid guaranteed profit, risk-free claims, fake urgency, and unsafe financial promises.

HOW TO BUY: users open the Mini App (${APP_URL}), pick a package, submit their channel link, and the campaign starts after review. Support: ${AGENCY_TG} or /support.

YOUR STYLE:
- Friendly, sharp, and concise — this is Telegram chat, keep answers short (under 200 words unless asked for detail).
- Use a few fitting emojis, never walls of them.
- You may use simple formatting: **bold**, bullet lists.
- Help with: choosing packages, channel growth strategy, marketing advice for trading channels, platform questions, general questions.
- If asked about prices or packages, use the exact package data above.
- When signed-in campaign data is available, use it to explain progress and reports. Never expose another user's campaign.
- Ask one short clarifying question when channel size, niche, or goal is required for a useful recommendation.
- End strategy answers with a concrete next action inside TELES ADS.
- If the user asks what to improve, give direct practical steps: channel positioning, content cadence, trust proof, pinned post, and package fit.
- If the user asks for a campaign report, explain that reports use the selected package member target and not a generic default.
- If a user wants to purchase or has a billing problem, direct them to the Mini App or ${AGENCY_TG}.
- Never invent features TELES ADS does not have. Never promise specific results or guaranteed profits.
- Politely refuse anything illegal or harmful.`;
}

// ---------------------------------------------------------------------------
// OpenRouter call with model fallback
// ---------------------------------------------------------------------------
async function callAiProvider(messages) {
  return aiClient.complete(messages);
}

async function generateReply(chatId, userText, deps) {
  await hydrateHistory(chatId);
  const messages = [
    { role: "system", content: await systemPrompt(deps) },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];
  const result = await callAiProvider(messages);
  if (result.ok) {
    pushHistory(chatId, "user", userText);
    pushHistory(chatId, "assistant", result.text);
    await persistentStore
      .saveConversation(chatId, deps?.userId, getHistory(chatId))
      .catch((error) => console.error("Teles Agent: failed to save memory:", error.message));
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
  if (!BOT_TOKEN) return null;
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
  let lastMessage = null;
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
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // HTML parse failure fallback: resend as plain text
        payload.text = chunks[i].replace(/<[^>]+>/g, "");
        delete payload.parse_mode;
        const fallback = await fetch(`${TG_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {});
        const fallbackBody = await fallback?.json().catch(() => ({}));
        lastMessage = fallbackBody?.result || lastMessage;
      } else {
        lastMessage = body.result || lastMessage;
      }
    } catch (err) {
      console.error("Teles Agent: sendMessage failed:", err.message);
    }
  }
  return lastMessage;
}

async function tgEdit(chatId, messageId, html, replyMarkup) {
  if (!BOT_TOKEN || !messageId) return null;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  };
  try {
    const response = await fetch(`${TG_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    return body.result || null;
  } catch (error) {
    console.error("Teles Agent: editMessageText failed:", error.message);
    return null;
  }
}

async function tgAnswerCallback(callbackQueryId, text = "") {
  if (!BOT_TOKEN || !callbackQueryId) return;
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

async function tgSendPhoto(chatId, caption, replyMarkup) {
  if (!BOT_TOKEN) return null;
  try {
    const response = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: LOGO_URL,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body.result : null;
  } catch {
    return null;
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
// Autonomous growth workflows
// ---------------------------------------------------------------------------
const FLOW_TTL_MS = 15 * 60 * 1000;

function setFlow(chatId, kind) {
  flows.set(String(chatId), { kind, createdAt: Date.now() });
}

function takeFlow(chatId) {
  const key = String(chatId);
  const flow = flows.get(key);
  if (!flow) return null;
  flows.delete(key);
  return Date.now() - flow.createdAt <= FLOW_TTL_MS ? flow : null;
}

function telegramUsername(update) {
  return update?.message?.from?.username || update?.callback_query?.from?.username || null;
}

async function livePackages(ctx) {
  try {
    if (ctx?.db && ctx?.packages) {
      return (await ctx.db.select().from(ctx.packages)).filter((item) => item.active !== false);
    }
  } catch (error) {
    console.error("Teles Agent: failed to load package rates:", error.message);
  }
  return [];
}

function copyAnalysis(channel) {
  const viewRate = channel.estimatedViewRate;
  const visibility =
    viewRate === null ? "unverified" : viewRate >= 35 ? "strong" : viewRate >= 15 ? "healthy" : "low";
  const cadence =
    channel.postsLast7d >= 14 ? "high" : channel.postsLast7d >= 5 ? "consistent" : "light";
  return {
    visibility,
    cadence,
    recommendation:
      visibility === "low"
        ? "Improve the channel bio, pinned offer, and content engagement before scaling traffic."
        : "Use the audience profile as a benchmark, then test a focused campaign without copying branding or content.",
  };
}

function formatMetric(value, suffix = "") {
  return value === null || value === undefined
    ? "Not available"
    : `${Number(value).toLocaleString()}${suffix}`;
}

async function runCopyAnalysis(ctx, target) {
  const { chatId, userId, update } = ctx;
  await tgTyping(chatId);
  const pending = await tgSend(chatId, "Analyzing the public channel and recent posts...");
  try {
    const channel = await intelligence.fetchChannelIntelligence(target, { botToken: BOT_TOKEN });
    const growth = await persistentStore.saveChannelSnapshot(channel);
    const budget = intelligence.estimateCopyBudget(channel.subscriberCount, await livePackages(ctx));
    const analysis = copyAnalysis(channel);
    const request = await persistentStore.createCopyRequest({
      telegramId: userId,
      username: telegramUsername(update),
      channel,
      growth,
      budget,
      analysis,
    });
    const growthText = growth
      ? `${growth.change >= 0 ? "+" : ""}${growth.change.toLocaleString()} since the last scan (${growth.dailyChange >= 0 ? "+" : ""}${growth.dailyChange.toLocaleString()}/day)`
      : "First scan - growth trend will appear next time";
    const html = `<b>Channel intelligence: ${escapeHtml(channel.title)}</b>\n\n` +
      `Channel: @${escapeHtml(channel.handle)}\n` +
      `Subscribers: <b>${formatMetric(channel.subscriberCount)}</b>\n` +
      `Average views: <b>${formatMetric(channel.avgViews)}</b> (${channel.postsSampled} posts sampled)\n` +
      `Estimated view rate: <b>${formatMetric(channel.estimatedViewRate, "%")}</b>\n` +
      `Estimated CTR proxy: <b>${formatMetric(channel.estimatedCtrProxy, "%")}</b>\n` +
      `Posts in 7 days: <b>${formatMetric(channel.postsLast7d)}</b>\n` +
      `Subscriber trend: ${escapeHtml(growthText)}\n\n` +
      `<b>Campaign model</b>\n` +
      `Suggested target: <b>${formatMetric(budget.suggestedTarget)} members</b>\n` +
      `Estimated budget: <b>$${formatMetric(budget.estimatedBudget)}</b>\n` +
      `Minimum managed budget: <b>$${formatMetric(budget.minimumBudget)}</b>\n\n` +
      `<b>Agent assessment:</b> ${escapeHtml(analysis.visibility)} visibility, ${escapeHtml(analysis.cadence)} posting cadence.\n` +
      `${escapeHtml(analysis.recommendation)}\n\n` +
      `<i>Public-data estimates are directional, not guaranteed results.</i>`;
    const keyboard = request?.id
      ? {
          inline_keyboard: [
            [{ text: "Build this campaign", callback_data: `copy_submit:${request.id}` }],
            [{ text: "Cancel", callback_data: `copy_cancel:${request.id}` }],
          ],
        }
      : { inline_keyboard: [[{ text: "Open campaign builder", web_app: { url: APP_URL } }]] };
    if (pending?.message_id) await tgEdit(chatId, pending.message_id, html, keyboard);
    else await tgSend(chatId, html, keyboard);
  } catch (error) {
    const message = `Could not analyze that channel: ${escapeHtml(error.message)}\n\nOnly public Telegram channels can be analyzed.`;
    if (pending?.message_id) await tgEdit(chatId, pending.message_id, message);
    else await tgSend(chatId, message);
  }
}

async function handleCallback(ctx) {
  const callback = ctx.update?.callback_query;
  if (!callback?.data) return false;
  const match = callback.data.match(/^copy_(submit|cancel):(\d+)$/);
  if (!match) return false;
  const request = await persistentStore.getCopyRequest(Number(match[2]));
  if (!request || Number(request.telegram_id) !== Number(ctx.userId)) {
    await tgAnswerCallback(callback.id, "This campaign request is unavailable.");
    return true;
  }
  await tgAnswerCallback(callback.id);
  const status = match[1] === "submit" ? "submitted" : "cancelled";
  await persistentStore.setCopyRequestStatus(request.id, status);
  const html = status === "submitted"
    ? `<b>Campaign brief saved</b>\n\nThe analysis for @${escapeHtml(request.target_handle)} is ready. Open TELES ADS to review the audience and complete your order.`
    : `<b>Campaign request cancelled</b>\n\nNo campaign was ordered and no charge was made.`;
  const keyboard = status === "submitted"
    ? { inline_keyboard: [[{ text: "Open TELES ADS", web_app: { url: APP_URL } }]] }
    : { inline_keyboard: [] };
  await tgEdit(ctx.chatId, callback.message?.message_id, html, keyboard);
  return true;
}

async function createHandoff(ctx, description) {
  const ticket = await persistentStore.createHumanTicket(
    ctx.userId,
    telegramUsername(ctx.update),
    description.slice(0, 2000)
  );
  await tgSend(
    ctx.chatId,
    `<b>Human support requested</b>\n\nTicket: <code>${escapeHtml(ticket.ticket_number)}</code>\nA TELES ADS specialist can now review your request. You can also contact ${AGENCY_TG}.`
  );
}

async function sendCampaignHealth(ctx) {
  const campaigns = await persistentStore.listActiveCampaigns(ctx.userId);
  if (!campaigns.length) {
    await tgSend(ctx.chatId, "No active campaigns were found for this Telegram account.");
    return;
  }
  const lines = campaigns.slice(0, 5).map((campaign) => {
    const health = intelligence.calculateCampaignHealth({
      status: campaign.status,
      membersTarget: campaign.members_target,
      membersDelivered: campaign.members_delivered,
      createdAt: campaign.created_at,
    });
    return `<b>${escapeHtml(campaign.package_name)}</b> - ${health.progress}% delivered, health ${health.score}/100 (${health.status})`;
  });
  await tgSend(ctx.chatId, `<b>Campaign health</b>\n\n${lines.join("\n")}`, {
    inline_keyboard: [[{ text: "Open live reports", web_app: { url: APP_URL } }]],
  });
}

async function sendAdminCopilot(ctx) {
  const stats = await persistentStore.adminCopilotStats();
  const pending = Number(stats.pending_campaigns || 0);
  const tickets = Number(stats.open_tickets || 0);
  const priority = tickets
    ? `Resolve ${tickets} open support ticket${tickets === 1 ? "" : "s"}.`
    : pending
      ? `Review ${pending} pending campaign${pending === 1 ? "" : "s"}.`
      : "No urgent queue items detected.";
  await tgSend(
    ctx.chatId,
    `<b>Admin copilot</b>\n\nUsers: <b>${formatMetric(stats.users || 0)}</b>\n` +
      `Active campaigns: <b>${formatMetric(stats.active_campaigns || 0)}</b>\n` +
      `Pending campaigns: <b>${formatMetric(pending)}</b>\n` +
      `Open tickets: <b>${formatMetric(tickets)}</b>\n` +
      `Copy-campaign leads: <b>${formatMetric(stats.copy_leads || 0)}</b>\n` +
      `Campaign value: <b>$${formatMetric(stats.campaign_value || 0)}</b>\n\n` +
      `<b>Next action:</b> ${escapeHtml(priority)}`
  );
}

async function monitorCampaigns() {
  if (!BOT_TOKEN || !process.env.DATABASE_URL) return;
  try {
    for (const campaign of await persistentStore.listActiveCampaigns()) {
      const target = Number(campaign.members_target) || 0;
      if (!target) continue;
      const progress = Math.min(100, (Number(campaign.members_delivered || 0) / target) * 100);
      let newest = null;
      for (const milestone of [25, 50, 75, 100]) {
        if (progress >= milestone && await persistentStore.markCampaignAlert(campaign.id, String(milestone))) {
          newest = milestone;
        }
      }
      if (newest !== null) {
        await tgSend(
          campaign.telegram_id,
          `<b>Campaign update</b>\n\n${escapeHtml(campaign.package_name)} reached <b>${newest}%</b> of its ${formatMetric(target)}-member target.`
        );
      }
    }
  } catch (error) {
    console.error("Teles Agent: campaign monitor failed:", error.message);
  }
}

let campaignMonitor = null;
function startCampaignMonitor() {
  if (campaignMonitor || !BOT_TOKEN || !process.env.DATABASE_URL) return;
  const intervalMs = Math.max(60_000, Number(process.env.AGENT_MONITOR_INTERVAL_MS) || 15 * 60_000);
  campaignMonitor = setInterval(monitorCampaigns, intervalMs);
  campaignMonitor.unref?.();
  setTimeout(monitorCampaigns, 10_000).unref?.();
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
🌐 /website — Visit egatusad.com
📖 /help — This list

💬 <b>Tip:</b> in this private chat, any plain message is answered by Teles Agent AI.`;
  t += `

<b>Agent workflows</b>
/copy &lt;channel&gt; - Analyze a public competitor channel
/health - Check active campaign health
/human - Hand off to a human specialist`;
  if (isAdmin) {
    t += "\n/copilot - Prioritized business overview";
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
    const callback = update?.callback_query;
    chatId = chatId || callback?.message?.chat?.id;
    userId = userId || callback?.from?.id;
    if (!chatId) return false;
    if (callback) return handleCallback({ ...ctx, chatId, userId, update });
    if (!text) return false;
    // Normalize "/cmd@BotName args" -> "/cmd args" (Telegram group syntax)
    if (text.startsWith("/")) text = text.replace(/^(\/[a-zA-Z0-9_]+)@\S+/, "$1");
    if (text === "/start" || text.startsWith("/start ")) return false;
    const isPrivate = update?.message?.chat?.type === "private";
    const isAdmin = ctx.adminId !== undefined && userId === ctx.adminId;
    const deps = {
      db: ctx.db,
      packages: ctx.packages,
      campaigns: ctx.campaigns,
      userId,
    };

    const flow = !text.startsWith("/") ? takeFlow(chatId) : null;
    if (flow?.kind === "copy_link") {
      await runCopyAnalysis({ ...ctx, chatId, userId, update }, text);
      return true;
    }
    if (flow?.kind === "human_reason") {
      await createHandoff({ ...ctx, chatId, userId, update }, text);
      return true;
    }

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

    // ---- /copy [public channel] --------------------------------------
    if (text === "/copy" || text.startsWith("/copy ") || text === "/analyze" || text.startsWith("/analyze ")) {
      const target = text.replace(/^\/(?:copy|analyze)\s*/, "").trim();
      if (!target) {
        setFlow(chatId, "copy_link");
        await tgSend(chatId, "Send the public Telegram channel link or @username you want to analyze.");
      } else {
        await runCopyAnalysis({ ...ctx, chatId, userId, update }, target);
      }
      return true;
    }

    // ---- /human [reason] ---------------------------------------------
    if (text === "/human" || text.startsWith("/human ")) {
      const reason = text.replace(/^\/human\s*/, "").trim();
      if (!reason) {
        setFlow(chatId, "human_reason");
        await tgSend(chatId, "Briefly describe what you need help with, and I will create a support handoff.");
      } else {
        await createHandoff({ ...ctx, chatId, userId, update }, reason);
      }
      return true;
    }

    // ---- /health -----------------------------------------------------
    if (text === "/health") {
      await sendCampaignHealth({ ...ctx, chatId, userId, update });
      return true;
    }

    // ---- /clear ---------------------------------------------------------
    if (text === "/clear") {
      clearHistory(chatId);
      await persistentStore
        .deleteConversation(chatId)
        .catch((error) => console.error("Teles Agent: failed to clear saved memory:", error.message));
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
    if (text === "/copilot") {
      if (!isAdmin) {
        await tgSend(chatId, "This command is restricted to admins only.");
      } else {
        await sendAdminCopilot({ ...ctx, chatId, userId, update });
      }
      return true;
    }

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
      {
        role: "system",
        content: await systemPrompt({ ...deps, userId: req.telegramUserId }),
      },
      ...past,
      { role: "user", content: trimmed },
    ];
    const result = await callAiProvider(messages);
    res.json({ reply: result.text, ok: result.ok, agent: "Teles Agent" });
  } catch (err) {
    console.error("Teles Agent apiChat error:", err);
    res.status(500).json({ error: "Teles Agent is unavailable right now." });
  }
}

startCampaignMonitor();

module.exports = {
  apiChat,
  handleUpdate,
  monitorCampaigns,
  parseMemberTarget,
  startCampaignMonitor,
};
