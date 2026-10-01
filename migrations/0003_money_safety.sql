-- 0003_money_safety.sql — Phase 3 money safety (#58–61, #71–85)
-- Wallets, append-only ledger, admin audit, invoice state columns + guards,
-- minor-unit price columns (#75), receipt immutability (#76), UNIQUE handle (#81)

/* ---------------------------------------------------------- wallets (#60/61) */
CREATE TABLE IF NOT EXISTS wallets (
  telegram_id    BIGINT PRIMARY KEY,
  balance_cents  INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* --------------------------------------------- ledger entries — source of truth */
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 BIGSERIAL PRIMARY KEY,
  telegram_id        BIGINT NOT NULL,
  amount_cents       INTEGER NOT NULL,           /* signed: + credit, - debit */
  kind               TEXT NOT NULL CHECK (kind IN ('topup','direct_payment','spend','refund','adjustment')),
  invoice_id         INTEGER REFERENCES invoices(id),
  campaign_id        INTEGER REFERENCES campaigns(id),
  actor_telegram_id  BIGINT,
  memo               TEXT NOT NULL DEFAULT '',
  idempotency_key    TEXT UNIQUE,                /* retry-safe grants (#73) */
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_by_user ON ledger_entries (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_by_invoice ON ledger_entries (invoice_id);

/* ----------------------------------------------------- admin audit (#77/#83) */
CREATE TABLE IF NOT EXISTS admin_audit (
  id                BIGSERIAL PRIMARY KEY,
  actor_telegram_id BIGINT NOT NULL,
  action            TEXT NOT NULL,
  entity            TEXT NOT NULL,
  entity_id         TEXT,
  reason            TEXT NOT NULL DEFAULT '',
  before            JSONB,
  "after"           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ------------------------------------------------ invoices: state machine (#71) */
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_cents    INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'campaign';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS verified_by     BIGINT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS verify_note     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS expired_reason  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS disputed        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_cents  INTEGER NOT NULL DEFAULT 0;
UPDATE invoices SET amount_cents = ROUND(amount * 100) WHERE amount_cents IS NULL;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_valid;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_valid CHECK (
  status IN ('pending','verification_submitted','paid','fulfilled','rejected','expired','cancelled','refunded')
);

/* --------------------------------------- receipts immutable once money landed (#76) */
CREATE OR REPLACE FUNCTION invoices_guard_receipt() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('paid','fulfilled','refunded')
     AND (NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.package_name IS DISTINCT FROM OLD.package_name
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number) THEN
    RAISE EXCEPTION 'invoice receipt fields are immutable once status=%', OLD.status;
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'invoice soft-delete is one-way';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS invoices_guard_receipt ON invoices;
CREATE TRIGGER invoices_guard_receipt BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_receipt();

/* ------------------------------------------- minor units everywhere new (#75) */
ALTER TABLE packages ADD COLUMN IF NOT EXISTS price_cents INTEGER;
UPDATE packages SET price_cents = price * 100 WHERE price_cents IS NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
UPDATE campaigns SET price_cents = ROUND(price * 100) WHERE price_cents IS NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS disputed BOOLEAN NOT NULL DEFAULT false;

/* ------------------------------------------- UNIQUE channel handle — no dupes (#81) */
CREATE UNIQUE INDEX IF NOT EXISTS channels_handle_unique ON channels (lower(handle));

/* --------------------------------- balance == SUM(ledger) verification helper (#85) */
CREATE OR REPLACE FUNCTION wallet_ledger_diff() RETURNS TABLE(telegram_id BIGINT, wallet_cents BIGINT, ledger_cents BIGINT) AS $$
  SELECT w.telegram_id,
         w.balance_cents::BIGINT,
         COALESCE((SELECT SUM(l.amount_cents) FROM ledger_entries l WHERE l.telegram_id = w.telegram_id), 0)::BIGINT
  FROM wallets w
  WHERE w.balance_cents <> COALESCE((SELECT SUM(l.amount_cents) FROM ledger_entries l WHERE l.telegram_id = w.telegram_id), 0)
$$ LANGUAGE sql;
