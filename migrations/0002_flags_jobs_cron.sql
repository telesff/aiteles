-- Phase 2: feature flags (#38), job queue (#32), cron heartbeat (#33)
CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  value JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO flags (key, enabled) VALUES
  ('strict_bot_admin', false),
  ('maintenance_mode', false),
  ('signup_enabled', true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, run_at);

CREATE TABLE IF NOT EXISTS cron_state (
  key TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_duration_ms INT,
  last_result TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
