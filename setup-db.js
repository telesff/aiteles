#!/usr/bin/env node
/**
 * TELES ADS — Database Setup Script
 * Run: node setup-db.js
 * Requires: DATABASE_URL environment variable
 */
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT,
  photo_url TEXT,
  language_code TEXT,
  channel_link TEXT,
  trading_category TEXT,
  referred_by BIGINT,
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  members INTEGER NOT NULL DEFAULT 0,
  growth_24h REAL NOT NULL DEFAULT 0,
  growth_7d REAL NOT NULL DEFAULT 0,
  engagement_rate REAL NOT NULL DEFAULT 0,
  avg_views_per_post INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'crypto',
  verified BOOLEAN NOT NULL DEFAULT false,
  quality_score REAL NOT NULL DEFAULT 0,
  top_countries TEXT NOT NULL DEFAULT '[]',
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT,
  package_name TEXT NOT NULL,
  channel_link TEXT NOT NULL,
  audience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  members_delivered INTEGER NOT NULL DEFAULT 0,
  members_target INTEGER NOT NULL DEFAULT 0,
  reach INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  ticket_number TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT NOT NULL,
  order_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  package_name TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS campaign_id INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS channel_link TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sender_wallet TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(18,6);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_address TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS monitoring_started_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS chain_confirmations INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_payment_id_idx
  ON invoices (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_number_idx
  ON invoices (invoice_number);

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_username TEXT NOT NULL,
  channel_link TEXT NOT NULL,
  budget TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT NOT NULL DEFAULT 'website',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_requests (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER,
  full_name TEXT NOT NULL,
  telegram_username TEXT NOT NULL,
  channel_link TEXT NOT NULL,
  monthly_budget TEXT NOT NULL,
  preferred_date TEXT NOT NULL,
  preferred_time TEXT NOT NULL,
  meeting_platform TEXT NOT NULL DEFAULT 'telegram',
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_campaign_requests (
  id SERIAL PRIMARY KEY,
  channel_link TEXT NOT NULL,
  current_members INTEGER NOT NULL,
  target_members INTEGER NOT NULL,
  budget REAL NOT NULL,
  target_countries TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  members TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]',
  price INTEGER NOT NULL DEFAULT 0,
  original_price INTEGER,
  popular BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leaderboard (
  id SERIAL PRIMARY KEY,
  rank INTEGER NOT NULL DEFAULT 0,
  channel_name TEXT NOT NULL,
  handle TEXT NOT NULL,
  growth INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'This Month',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed default packages (skip if already exist)
INSERT INTO packages (name, description, members, features, price, original_price, popular)
SELECT 'Best Package', 'Perfect for growing channels', '5,000–10,000', '["Targeted reach","Analytics dashboard","24/7 support"]', 199, 250, false
WHERE NOT EXISTS (SELECT 1 FROM packages WHERE name = 'Best Package');

INSERT INTO packages (name, description, members, features, price, original_price, popular)
SELECT 'Recommended Package', 'Most popular choice for serious growth', '15,000–25,000', '["Premium targeting","Advanced analytics","Priority support","Campaign manager"]', 359, 450, true
WHERE NOT EXISTS (SELECT 1 FROM packages WHERE name = 'Recommended Package');

INSERT INTO packages (name, description, members, features, price, original_price, popular)
SELECT 'Luxury Package', 'Maximum exposure for elite channels', '50,000+', '["Ultra-premium reach","Real-time analytics","Dedicated manager","Custom strategy"]', 599, 750, false
WHERE NOT EXISTS (SELECT 1 FROM packages WHERE name = 'Luxury Package');

-- Seed default leaderboard
INSERT INTO leaderboard (rank, channel_name, handle, growth, period)
SELECT 1, 'CryptoSignals Pro', '@cryptosignalspro', 12400, 'This Month'
WHERE NOT EXISTS (SELECT 1 FROM leaderboard LIMIT 1);

INSERT INTO leaderboard (rank, channel_name, handle, growth, period)
SELECT 2, 'ForexElite', '@forexelite', 9800, 'This Month'
WHERE NOT EXISTS (SELECT 1 FROM leaderboard WHERE rank = 2);

INSERT INTO leaderboard (rank, channel_name, handle, growth, period)
SELECT 3, 'BinaryKings', '@binarykings', 7650, 'This Month'
WHERE NOT EXISTS (SELECT 1 FROM leaderboard WHERE rank = 3);
`;

async function setup() {
  console.log("Connecting to database...");
  const client = await pool.connect();
  try {
    console.log("Running schema setup...");
    await client.query(SQL);
    console.log("✅ Database setup complete! All tables created and seeded.");
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch((err) => {
  console.error("❌ Database setup failed:", err.message);
  process.exit(1);
});
