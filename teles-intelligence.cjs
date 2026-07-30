"use strict";

function parseTelegramChannel(value) {
  if (typeof value !== "string") return null;
  let input = value.trim();
  if (!input) return null;
  input = input.replace(/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i, "");
  input = input.replace(/^s\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
  if (input.startsWith("+") || /^joinchat$/i.test(input)) return null;
  return /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(input) ? input : null;
}

function parseCompactNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kmb])?/);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  return Math.round(Number.parseFloat(match[1]) * (multipliers[match[2]] || 1));
}

function extractPublicPostStats(html) {
  if (!html) return { views: [], dates: [] };
  const views = [];
  const viewPattern = /tgme_widget_message_views[^>]*>([^<]+)</g;
  for (const match of html.matchAll(viewPattern)) {
    const parsed = parseCompactNumber(match[1]);
    if (parsed !== null) views.push(parsed);
  }
  const dates = [];
  const datePattern = /<time[^>]+datetime="([^"]+)"/g;
  for (const match of html.matchAll(datePattern)) {
    const date = new Date(match[1]);
    if (!Number.isNaN(date.getTime())) dates.push(date);
  }
  return { views, dates };
}

async function telegramApi(method, payload, options) {
  const token = options.botToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await options.fetchImpl(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.description || `Telegram returned HTTP ${response.status}`);
  }
  return body.result;
}

async function fetchChannelIntelligence(value, options = {}) {
  const handle = parseTelegramChannel(value);
  if (!handle) {
    throw new Error("Send a public Telegram link such as https://t.me/channelname.");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  try {
    const requestOptions = {
      botToken: options.botToken || process.env.TELEGRAM_BOT_TOKEN || "",
      fetchImpl,
      signal: controller.signal,
    };
    const [chat, subscriberCount, publicPage] = await Promise.all([
      telegramApi("getChat", { chat_id: `@${handle}` }, requestOptions),
      telegramApi("getChatMemberCount", { chat_id: `@${handle}` }, requestOptions),
      fetchImpl(`https://t.me/s/${handle}`, {
        headers: { "User-Agent": "TELES-ADS-Channel-Research/1.0" },
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => ""),
    ]);
    const postStats = extractPublicPostStats(publicPage);
    const recentViews = postStats.views.slice(-20);
    const avgViews = recentViews.length
      ? Math.round(recentViews.reduce((total, views) => total + views, 0) / recentViews.length)
      : null;
    const viewRate = avgViews && subscriberCount
      ? Number(((avgViews / subscriberCount) * 100).toFixed(2))
      : null;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const postsLast7d = postStats.dates.filter((date) => date.getTime() >= weekAgo).length;
    return {
      handle,
      url: `https://t.me/${handle}`,
      title: chat.title || handle,
      description: chat.description || "",
      subscriberCount: Number(subscriberCount),
      avgViews,
      estimatedViewRate: viewRate,
      estimatedCtrProxy: viewRate === null ? null : Number((viewRate * 0.12).toFixed(2)),
      postsSampled: recentViews.length,
      postsLast7d,
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parsePackageTarget(value) {
  if (typeof value !== "string") return null;
  const values = value.match(/\d[\d,.]*(?:\s*[kKmM](?![a-zA-Z]))?/g) || [];
  const parsed = values.map(parseCompactNumber).filter((number) => number && number > 0);
  return parsed.length ? Math.max(...parsed) : null;
}

function estimateCopyBudget(subscriberCount, packages = []) {
  const packageRates = packages
    .map((item) => {
      const target = parsePackageTarget(item.members || "");
      const price = Number(item.price);
      return target && price > 0 ? price / target : null;
    })
    .filter((rate) => rate && Number.isFinite(rate))
    .sort((a, b) => a - b);
  const medianRate = packageRates.length
    ? packageRates[Math.floor(packageRates.length / 2)]
    : 0.08;
  const suggestedTarget = Math.min(
    100_000,
    Math.max(2_500, Math.round((Number(subscriberCount) || 0) * 0.1))
  );
  const estimated = Math.max(789, suggestedTarget * medianRate);
  return {
    minimumBudget: 789,
    estimatedBudget: Math.ceil(estimated / 10) * 10,
    suggestedTarget,
    estimatedCostPerMember: Number(medianRate.toFixed(4)),
  };
}

function calculateCampaignHealth(campaign) {
  const target = Number(campaign.membersTarget) || 0;
  const delivered = Number(campaign.membersDelivered) || 0;
  const progress = target > 0 ? Math.min(100, (delivered / target) * 100) : 0;
  const created = new Date(campaign.createdAt || Date.now()).getTime();
  const ageDays = Math.max(1, (Date.now() - created) / 86_400_000);
  const pace = progress / ageDays;
  let score = Math.round(progress * 0.7 + Math.min(30, pace * 5));
  if (campaign.status === "completed") score = 100;
  if (campaign.status === "cancelled") score = 0;
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    progress: Number(progress.toFixed(1)),
    pacePerDay: Number(pace.toFixed(1)),
    status:
      score >= 80 ? "strong" : score >= 55 ? "healthy" : score >= 30 ? "needs attention" : "at risk",
  };
}

module.exports = {
  calculateCampaignHealth,
  estimateCopyBudget,
  extractPublicPostStats,
  fetchChannelIntelligence,
  parseCompactNumber,
  parsePackageTarget,
  parseTelegramChannel,
};
