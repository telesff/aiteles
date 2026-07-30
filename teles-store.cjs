"use strict";

let pool = null;
let schemaReady = null;

const AGENT_SCHEMA = `
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS telegram_username TEXT;

CREATE TABLE IF NOT EXISTS agent_conversations (
  chat_id TEXT PRIMARY KEY,
  telegram_id BIGINT,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_intelligence_snapshots (
  id SERIAL PRIMARY KEY,
  handle TEXT NOT NULL,
  subscribers INTEGER NOT NULL,
  avg_views INTEGER,
  estimated_view_rate REAL,
  posts_last_7d INTEGER,
  captured_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS channel_intelligence_handle_date_idx
  ON channel_intelligence_snapshots (handle, captured_at DESC);

CREATE TABLE IF NOT EXISTS copy_campaign_requests (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  username TEXT,
  target_handle TEXT NOT NULL,
  target_title TEXT NOT NULL,
  subscribers INTEGER NOT NULL,
  avg_views INTEGER,
  estimated_view_rate REAL,
  estimated_ctr_proxy REAL,
  subscriber_growth JSONB,
  minimum_budget REAL NOT NULL DEFAULT 789,
  estimated_budget REAL NOT NULL,
  suggested_target INTEGER NOT NULL,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'analyzed',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_campaign_alerts (
  campaign_id INTEGER NOT NULL,
  milestone TEXT NOT NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, milestone)
);`;

function database() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    // Keep the agent importable in local/test environments where persistence is
    // intentionally disabled and production dependencies may not be installed.
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function query(text, params = []) {
  const db = database();
  if (!db) return { rows: [], rowCount: 0 };
  if (!schemaReady) {
    schemaReady = db.query(AGENT_SCHEMA).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  return db.query(text, params);
}

async function loadConversation(chatId) {
  const result = await query(
    "SELECT messages FROM agent_conversations WHERE chat_id = $1 LIMIT 1",
    [String(chatId)]
  );
  return Array.isArray(result.rows[0]?.messages) ? result.rows[0].messages : [];
}

async function saveConversation(chatId, userId, messages) {
  await query(
    `INSERT INTO agent_conversations (chat_id, telegram_id, messages, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       telegram_id = EXCLUDED.telegram_id,
       messages = EXCLUDED.messages,
       updated_at = NOW()`,
    [String(chatId), userId || null, JSON.stringify(messages)]
  );
}

async function deleteConversation(chatId) {
  await query("DELETE FROM agent_conversations WHERE chat_id = $1", [String(chatId)]);
}

async function saveChannelSnapshot(channel) {
  const previousResult = await query(
    `SELECT subscribers, captured_at
     FROM channel_intelligence_snapshots
     WHERE handle = $1
     ORDER BY captured_at DESC
     LIMIT 1`,
    [channel.handle.toLowerCase()]
  );
  await query(
    `INSERT INTO channel_intelligence_snapshots
      (handle, subscribers, avg_views, estimated_view_rate, posts_last_7d, captured_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      channel.handle.toLowerCase(),
      channel.subscriberCount,
      channel.avgViews,
      channel.estimatedViewRate,
      channel.postsLast7d,
    ]
  );
  const previous = previousResult.rows[0];
  if (!previous) return null;
  const elapsedDays = Math.max(
    1 / 24,
    (Date.now() - new Date(previous.captured_at).getTime()) / 86_400_000
  );
  const change = channel.subscriberCount - Number(previous.subscribers);
  return {
    previousSubscribers: Number(previous.subscribers),
    change,
    percent: previous.subscribers
      ? Number(((change / Number(previous.subscribers)) * 100).toFixed(2))
      : null,
    elapsedDays: Number(elapsedDays.toFixed(1)),
    dailyChange: Math.round(change / elapsedDays),
  };
}

async function createCopyRequest(request) {
  const result = await query(
    `INSERT INTO copy_campaign_requests
      (telegram_id, username, target_handle, target_title, subscribers, avg_views,
       estimated_view_rate, estimated_ctr_proxy, subscriber_growth, minimum_budget,
       estimated_budget, suggested_target, analysis, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,'analyzed',NOW(),NOW())
     RETURNING *`,
    [
      request.telegramId,
      request.username || null,
      request.channel.handle,
      request.channel.title,
      request.channel.subscriberCount,
      request.channel.avgViews,
      request.channel.estimatedViewRate,
      request.channel.estimatedCtrProxy,
      JSON.stringify(request.growth || null),
      request.budget.minimumBudget,
      request.budget.estimatedBudget,
      request.budget.suggestedTarget,
      JSON.stringify(request.analysis || {}),
    ]
  );
  return result.rows[0] || null;
}

async function getCopyRequest(id) {
  const result = await query("SELECT * FROM copy_campaign_requests WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function setCopyRequestStatus(id, status) {
  const result = await query(
    `UPDATE copy_campaign_requests SET status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return result.rows[0] || null;
}

async function createHumanTicket(userId, username, description) {
  const ticketNumber = `AI-${Date.now().toString(36).toUpperCase()}`;
  const result = await query(
    `INSERT INTO tickets
      (ticket_number, subject, category, status, description, telegram_id, telegram_username,
       created_at, updated_at)
     VALUES ($1, 'Teles Agent handoff', 'ai_handoff', 'open', $2, $3, $4, NOW(), NOW())
     RETURNING id, ticket_number`,
    [ticketNumber, description, userId || null, username || null]
  );
  return result.rows[0] || { ticket_number: ticketNumber };
}

async function listActiveCampaigns(telegramId = null) {
  const params = telegramId === null || telegramId === undefined ? [] : [telegramId];
  const ownerClause = params.length ? " AND telegram_id = $1" : "";
  const result = await query(
    `SELECT id, telegram_id, package_name, channel_link, status, members_delivered,
            members_target, price, created_at
     FROM campaigns
     WHERE telegram_id IS NOT NULL AND status IN ('active', 'pending')${ownerClause}`,
    params
  );
  return result.rows;
}

async function markCampaignAlert(campaignId, milestone) {
  const result = await query(
    `INSERT INTO agent_campaign_alerts (campaign_id, milestone, sent_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (campaign_id, milestone) DO NOTHING
     RETURNING campaign_id`,
    [campaignId, milestone]
  );
  return result.rowCount > 0;
}

async function adminCopilotStats() {
  const result = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(*)::int FROM campaigns WHERE status = 'pending') AS pending_campaigns,
       (SELECT COUNT(*)::int FROM campaigns WHERE status = 'active') AS active_campaigns,
       (SELECT COUNT(*)::int FROM tickets WHERE status IN ('open','pending')) AS open_tickets,
       (SELECT COUNT(*)::int FROM copy_campaign_requests WHERE status = 'submitted') AS copy_leads,
       (SELECT COALESCE(SUM(price),0)::float FROM campaigns) AS campaign_value`
  );
  return result.rows[0] || {};
}

module.exports = {
  adminCopilotStats,
  createCopyRequest,
  createHumanTicket,
  database,
  deleteConversation,
  getCopyRequest,
  listActiveCampaigns,
  loadConversation,
  markCampaignAlert,
  saveChannelSnapshot,
  saveConversation,
  setCopyRequestStatus,
};
