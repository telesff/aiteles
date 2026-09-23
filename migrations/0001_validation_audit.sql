-- Phase 2 migrations — validation audit (already applied in Phase 1; recorded by runner)
CREATE TABLE IF NOT EXISTS validation_audit (
  id SERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  telegram_id BIGINT,
  input_raw TEXT NOT NULL,
  input_norm TEXT,
  code TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS validation_audit_user_time_idx
  ON validation_audit (telegram_id, created_at DESC);
