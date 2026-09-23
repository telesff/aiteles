-- DEV FIXTURES ONLY — never run against production.
-- Usage (local dev only): psql "$LOCAL_DEV_DATABASE_URL" -f seeds/dev-fixtures.sql
--
-- Policy (planworkv1 #35): production bootstrap data lives in setup-db.js
-- (packages + leaderboard, idempotent WHERE NOT EXISTS). Everything in this
-- file is obviously-fake test data for local environments and is NOT
-- referenced by setup-db.js, migrate.cjs, or any deploy step.

BEGIN;

INSERT INTO channels (name, handle, members, category, description, active)
VALUES
  ('DEV Fixture Alpha', '@devfixturealpha', 1111, 'crypto', 'local-only fixture', false),
  ('DEV Fixture Beta', '@devfixturebeta', 2222, 'forex', 'local-only fixture', false)
ON CONFLICT DO NOTHING;

INSERT INTO flags (key, enabled) VALUES ('dev_fixture_marker', true)
ON CONFLICT (key) DO NOTHING;

COMMIT;
