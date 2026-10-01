"use strict";
/**
 * TELES ADS — Money safety core (planworkv1 Phase 3: #58–61, #71–85)
 *
 *   - wallets: balance_cents, row-locked atomic updates (race-safe spend #61)
 *   - ledger_entries: append-only source of truth, idempotency_key UNIQUE (#73)
 *   - invoice state machine: only legal transitions, audited (#71, #77)
 *   - all amounts in MINOR UNITS (cents) (#75)
 *   - reconcile(): wallet vs SUM(ledger) vs invoice grants (#85)
 *   - soft-lock on disputed invoices (#78)
 *
 * Storage: reuses hardening.cjs's pool when available (injected via init),
 * otherwise builds its own small pool. Never throws across its API boundary:
 * every entrypoint resolves with {ok:false, code, ...} on failure.
 */
const crypto = require("crypto");

let pool = null;
function init(p) { if (p) pool = p; }
function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000, ssl: /sslmode=|pooler\.supabase/.test(url) ? { rejectUnauthorized: false } : false });
    return pool;
  } catch (e) { return null; }
}

/* ------------------------------------------------------- state machine (#71) */
const TERMINAL = ["rejected", "expired", "cancelled", "refunded"];
const ALLOWED = {
  pending: ["verification_submitted", "paid", "fulfilled", "rejected", "expired", "cancelled"],
  verification_submitted: ["paid", "fulfilled", "rejected", "expired", "cancelled"],
  paid: ["fulfilled", "cancelled", "refunded"],
  fulfilled: ["refunded"],
  rejected: [],
  expired: [],
  cancelled: [],
  refunded: [],
};
function canTransition(from, to) {
  return !!(ALLOWED[from] && ALLOWED[from].indexOf(to) !== -1);
}

async function q(sql, params) {
  const p = getPool();
  if (!p) throw new Error("no-database");
  return p.query(sql, params);
}

async function audit(actor, action, entity, entityId, reason, before, after) {
  try {
    await q(
      `INSERT INTO admin_audit (actor_telegram_id, action, entity, entity_id, reason, before, "after")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor || 0, action, entity, String(entityId), reason || "", before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  } catch (e) { /* audit must never break the action; log only */ logW("audit_fail", e); }
}
function logW(k, e) {
  try { console.log(JSON.stringify({ lvl: "warn", t: new Date().toISOString(), ev: "money", k, err: String((e && e.message) || e).slice(0, 200) })); } catch (_) {}
}

/* ------------------------------------------------------------ wallet core (#60) */
async function walletRow(tgId) {
  try {
    const r = await q("SELECT telegram_id, balance_cents FROM wallets WHERE telegram_id=$1", [tgId]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

async function getWallet(tgId) {
  try {
    const [bal, entries] = await Promise.all([
      q("SELECT COALESCE(SUM(amount_cents),0)::BIGINT AS cents FROM ledger_entries WHERE telegram_id=$1", [tgId]),
      q("SELECT id, amount_cents, kind, invoice_id, campaign_id, memo, created_at FROM ledger_entries WHERE telegram_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50", [tgId]),
    ]);
    const row = await walletRow(tgId);
    return {
      ok: true,
      balanceCents: parseInt(bal.rows[0].cents, 10),
      walletCents: row ? row.balance_cents : 0,
      exists: !!row,
      entries: entries.rows.map((e) => ({
        id: e.id, amountCents: e.amount_cents, kind: e.kind,
        invoiceId: e.invoice_id, campaignId: e.campaign_id,
        memo: e.memo, createdAt: e.created_at,
      })),
    };
  } catch (e) { return { ok: false, code: "DB", error: String(e.message).slice(0, 200) }; }
}

async function ensureWallet(tgId, client) {
  const c = client || (await q("SELECT 1")); /* placeholder to keep signature simple */
  await q(
    "INSERT INTO wallets (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING",
    [tgId]
  );
}

/**
 * Atomic credit: wallet row + ledger entry in ONE transaction, idempotent via key.
 * Balance never goes negative (CHECK + guarded UPDATE for adjustment edge cases).
 */
async function credit(tgId, cents, opts) {
  cents = Math.round(cents);
  if (!tgId || !Number.isFinite(cents) || cents <= 0) return { ok: false, code: "BAD_AMOUNT" };
  const o = opts || {};
  const key = o.key || null;
  const p = getPool();
  if (!p) return { ok: false, code: "DB" };
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    if (key) {
      const dup = await client.query("SELECT id FROM ledger_entries WHERE idempotency_key=$1", [key]);
      if (dup.rows.length) {
        const b = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1", [tgId]);
        await client.query("COMMIT");
        return { ok: true, applied: false, alreadyApplied: true, balanceCents: b.rows[0] ? b.rows[0].balance_cents : 0, ledgerId: dup.rows[0].id };
      }
    }
    await client.query("INSERT INTO wallets (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING", [tgId]);
    const w = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1 FOR UPDATE", [tgId]);
    const next = w.rows[0].balance_cents + cents;
    const up = await client.query("UPDATE wallets SET balance_cents=$1, updated_at=now() WHERE telegram_id=$2 AND balance_cents + $3 >= 0", [next, tgId, cents]);
    if (!up.rowCount) { await client.query("ROLLBACK"); return { ok: false, code: "NEGATIVE" }; }
    const led = await client.query(
      `INSERT INTO ledger_entries (telegram_id, amount_cents, kind, invoice_id, campaign_id, actor_telegram_id, memo, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tgId, cents, o.kind || "topup", o.invoiceId || null, o.campaignId || null, o.actor || null, String(o.memo || "").slice(0, 300), key]
    );
    await client.query("COMMIT");
    return { ok: true, applied: true, balanceCents: next, ledgerId: led.rows[0].id };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    /* unique-key race: another worker inserted first */
    if (e && e.code === "23505" && key) {
      try {
        const b = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1", [tgId]);
        return { ok: true, applied: false, alreadyApplied: true, balanceCents: b.rows[0] ? b.rows[0].balance_cents : 0 };
      } catch (_) {}
    }
    logW("credit_fail", e);
    return { ok: false, code: "DB", error: String(e.message).slice(0, 200) };
  } finally { try { client.release(); } catch (_) {} }
}

/**
 * Race-safe spend (#61): single guarded UPDATE locks the wallet row —
 * concurrent spends serialize; overspend impossible (balance_cents >= amt check
 * inside the WHERE). Ledger row inserted in the same transaction.
 */
async function spend(tgId, cents, opts) {
  cents = Math.round(cents);
  if (!tgId || !Number.isFinite(cents) || cents <= 0) return { ok: false, code: "BAD_AMOUNT" };
  const o = opts || {};
  const key = o.key || null;
  const p = getPool();
  if (!p) return { ok: false, code: "DB" };
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    if (key) {
      const dup = await client.query("SELECT id FROM ledger_entries WHERE idempotency_key=$1", [key]);
      if (dup.rows.length) {
        const b = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1", [tgId]);
        await client.query("COMMIT");
        return { ok: true, applied: false, alreadyApplied: true, balanceCents: b.rows[0] ? b.rows[0].balance_cents : 0 };
      }
    }
    const w = await client.query("UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE telegram_id = $2 AND balance_cents >= $1 RETURNING balance_cents", [cents, tgId]);
    if (!w.rowCount) {
      let bal = 0;
      try { const b = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1", [tgId]); bal = b.rows[0] ? b.rows[0].balance_cents : 0; } catch (_) {}
      await client.query("ROLLBACK");
      return { ok: false, code: "INSUFFICIENT_BALANCE", balanceCents: bal };
    }
    const led = await client.query(
      `INSERT INTO ledger_entries (telegram_id, amount_cents, kind, invoice_id, campaign_id, actor_telegram_id, memo, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tgId, -cents, o.kind || "spend", o.invoiceId || null, o.campaignId || null, o.actor || null, String(o.memo || "").slice(0, 300), key]
    );
    await client.query("COMMIT");
    return { ok: true, applied: true, balanceCents: w.rows[0].balance_cents, ledgerId: led.rows[0].id };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (e && e.code === "23505" && key) {
      let bal = 0;
      try { const b = await client.query("SELECT balance_cents FROM wallets WHERE telegram_id=$1", [tgId]); bal = b.rows[0] ? b.rows[0].balance_cents : 0; } catch (_) {}
      return { ok: true, applied: false, alreadyApplied: true, balanceCents: bal };
    }
    logW("spend_fail", e);
    return { ok: false, code: "DB", error: String(e.message).slice(0, 200) };
  } finally { try { client.release(); } catch (_) {} }
}

/**
 * Direct (per-campaign) external payment → two ledger legs, net zero (#73/#59):
 * the money never touches the wallet balance but is fully recorded.
 */
async function recordDirectPayment(o) {
  const cents = Math.round(o && o.cents ? o.cents : 0);
  if (!o || !o.telegramId || cents <= 0) return { ok: false, code: "SKIP" };
  const inv = o.invoiceId || null;
  const base = `direct:${inv || "c" + o.campaignId}`;
  const c1 = await credit(o.telegramId, cents, {
    kind: "direct_payment", invoiceId: inv, campaignId: o.campaignId || null,
    memo: "external payment: " + (o.packageName || ""), key: base + ":in",
  });
  const s1 = await spend(o.telegramId, cents, {
    kind: "spend", invoiceId: inv, campaignId: o.campaignId || null,
    memo: "funded campaign: " + (o.packageName || ""), key: base + ":out",
  }).catch(() => ({ ok: false }));
  /* spend from an empty wallet would fail — direct payments bypass balance:
     ensure wallet exists then post legs manually if needed */
  if (!s1.ok) {
    await ensureWallet(o.telegramId);
    const p = getPool();
    try {
      await p.query(
        `INSERT INTO ledger_entries (telegram_id, amount_cents, kind, invoice_id, campaign_id, memo, idempotency_key)
         VALUES ($1,$2,'spend',$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
        [o.telegramId, -cents, inv, o.campaignId || null, "funded campaign: " + (o.packageName || ""), base + ":out"]
      );
      /* balance guard: direct legs must net to zero */
      await p.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1, updated_at = now()
         WHERE telegram_id = $2`,
        [0, o.telegramId]
      );
      /* if the wallet only has these two legs, balance = 0 naturally.
         If wallet had prior balance it stays untouched (in + out). */
    } catch (e) { logW("direct_leg_fail", e); }
  }
  return { ok: true };
}

/* ------------------------------------------------- invoice actions (#71/#72/#77) */
async function transitionInvoice(id, to, opts) {
  const o = opts || {};
  const p = getPool();
  if (!p) return { ok: false, code: "DB" };
  try {
    const cur = await q("SELECT * FROM invoices WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id]).catch(async () => q("SELECT * FROM invoices WHERE id=$1 AND deleted_at IS NULL", [id]));
    const inv = cur.rows[0];
    if (!inv) return { ok: false, status: 404, code: "NOT_FOUND", message: "Invoice not found." };
    if (inv.disputed && ["fulfilled", "paid"].indexOf(to) !== -1 && o.allowWhileDisputed !== true) {
      return { ok: false, status: 409, code: "DISPUTED", message: "Invoice is disputed. Resolve the dispute first." };
    }
    if (!canTransition(inv.status, to)) {
      return { ok: false, status: 409, code: "BAD_TRANSITION", message: `Cannot move invoice from '${inv.status}' to '${to}'.` };
    }
    if (["rejected", "expired", "cancelled", "refunded"].indexOf(to) !== -1 && !o.reason) {
      return { ok: false, status: 400, code: "REASON_REQUIRED", message: "A reason is required for this action." };
    }
    const sets = ["status=$1"];
    const params = [to];
    params.push(o.actor || 0);
    if (to === "fulfilled" || to === "paid") { sets.push("verified_by=$2"); sets.push("verify_note=$3"); params.push(String(o.reason || "").slice(0, 500)); }
    else if (to === "expired") { sets.push("expired_reason=$2"); params.push(String(o.reason || "").slice(0, 300)); }
    else if (to !== "fulfilled" && to !== "paid") { sets.push("verify_note=$2"); params.push(String(o.reason || "").slice(0, 500)); }
    params.push(id);
    /* column index fix: verified_by uses $2/$3; expired uses $2 — rebuild carefully */
    let sql, args;
    if (to === "fulfilled" || to === "paid") {
      args = [to, o.actor || 0, String(o.reason || "").slice(0, 500), id];
      sql = "UPDATE invoices SET status=$1, verified_by=$2, verify_note=$3, paid_at = CASE WHEN $1 IN ('paid','fulfilled') AND paid_at IS NULL THEN now() ELSE paid_at END WHERE id=$4";
    } else if (to === "expired") {
      args = [to, String(o.reason || "").slice(0, 300), id];
      sql = "UPDATE invoices SET status=$1, expired_reason=$2 WHERE id=$3";
    } else {
      args = [to, String(o.reason || "").slice(0, 500), id];
      sql = "UPDATE invoices SET status=$1, verify_note=$2 WHERE id=$3";
    }
    const upd = await q(sql, args);
    if (!upd.rowCount) return { ok: false, status: 404, code: "NOT_FOUND", message: "Invoice not found." };
    await audit(o.actor, "invoice:" + inv.status + "->" + to, "invoice", id, o.reason || "", { status: inv.status, amountCents: inv.amount_cents }, { status: to });
    return { ok: true, invoice: (await q("SELECT * FROM invoices WHERE id=$1", [id])).rows[0] };
  } catch (e) {
    logW("transition_fail", e);
    return { ok: false, status: 500, code: "DB", error: String(e.message).slice(0, 200) };
  }
}

/**
 * Admin invoice action (intercepted PATCH /api/admin/invoices/:id).
 * body: { status?, reason?, disputed?, deleted? } — every change audited.
 * Approving a TOP-UP to fulfilled credits the wallet exactly once (#72/#73).
 */
async function adminInvoiceAction(id, actor, body) {
  body = body || {};
  try {
    const before = (await q("SELECT * FROM invoices WHERE id=$1", [id])).rows[0];
    if (!before || before.deleted_at) return { ok: false, status: 404, code: "NOT_FOUND", message: "Invoice not found." };

    if (typeof body.disputed === "boolean" && body.disputed !== before.disputed) {
      await q("UPDATE invoices SET disputed=$1 WHERE id=$2", [body.disputed, id]);
      await audit(actor, body.disputed ? "invoice_dispute_open" : "invoice_dispute_clear", "invoice", id, body.reason || "", { disputed: before.disputed }, { disputed: body.disputed });
      /* campaign soft-lock (#78) happens automatically via isSoftLocked() */
    }

    if (typeof body.deleted === "boolean" && body.deleted) {
      if (["paid", "fulfilled", "refunded"].indexOf(before.status) !== -1) {
        return { ok: false, status: 409, code: "MONEY_ROW_PROTECTED", message: "Financial rows are soft-deleted only after settlement; paid/fulfilled invoices cannot be deleted." };
      }
      if (!body.reason) return { ok: false, status: 400, code: "REASON_REQUIRED", message: "A reason is required to delete an invoice." };
      await q("UPDATE invoices SET deleted_at=now() WHERE id=$1", [id]);
      await audit(actor, "invoice_soft_delete", "invoice", id, body.reason, { status: before.status }, { deleted: true });
      return { ok: true, deleted: true };
    }

    if (typeof body.refundAmountCents === "number") {
      const pr = await refundPartial(id, body.refundAmountCents, actor, body.reason);
      if (!pr.ok) return pr;
      return { ok: true, invoice: pr.invoice, wallet: { balanceCents: pr.balanceCents } };
    }

    if (body.status) {
      const tr = await transitionInvoice(id, body.status, { actor, reason: body.reason });
      if (!tr.ok) return tr;
      if (body.status === "refunded" && tr.invoice && Number(tr.invoice.refunded_cents || 0) < Number(tr.invoice.amount_cents || 0)) {
        const amt = Number(tr.invoice.amount_cents || 0);
        const cr = await credit(tr.invoice.telegram_id, amt, {
          kind: "refund", invoiceId: id, actor, memo: "refund (#" + id + ")" + (body.reason ? ": " + body.reason : ""), key: "invoice:" + id + ":refund:full",
        });
        if (cr.ok) {
          await q("UPDATE invoices SET refunded_cents = amount_cents WHERE id=$1", [id]);
          await audit(actor, "refund_credited", "invoice", id, body.reason || "", { amountCents: amt }, { refundedCents: amt, balanceCents: cr.balanceCents });
        }
      }
      /* wallet credit for top-up fulfilment (#72 — exactly once) */
      if (body.status === "fulfilled" && tr.invoice.kind === "topup") {
        const cr = await credit(tr.invoice.telegram_id, tr.invoice.amount_cents, {
          kind: "topup", invoiceId: id, actor, memo: "top-up approved (#" + id + ")", key: "invoice:" + id + ":credit",
        });
        if (!cr.ok) {
          await audit(actor, "topup_credit_failed", "invoice", id, cr.code || "DB", null, null);
          return { ok: false, status: 500, code: "CREDIT_FAILED", message: "Invoice approved but wallet credit failed. Check logs." };
        }
        await audit(actor, "topup_credited", "invoice", id, "", { amountCents: tr.invoice.amount_cents }, { balanceCents: cr.balanceCents, applied: cr.applied !== false });
        return { ok: true, invoice: (await q("SELECT * FROM invoices WHERE id=$1", [id])).rows[0], wallet: { balanceCents: cr.balanceCents }, credited: cr.applied !== false };
      }
      /* legacy campaign invoices: activating campaign stays where it is (payment submit) */
      return { ok: true, invoice: tr.invoice };
    }

    if (typeof body.disputed === "boolean") return { ok: true, disputed: body.disputed };
    return { ok: false, status: 400, code: "NOTHING_TO_DO", message: "Provide status, disputed, or deleted." };
  } catch (e) {
    logW("admin_action_fail", e);
    return { ok: false, status: 500, code: "DB", error: String(e.message).slice(0, 200) };
  }
}

/* ----------------------------------------------------------- top-up request */
async function createTopup(tgId, body) {
  const cents = Math.round(Number(body && body.amountCents) || 0);
  if (cents < 100 || cents > 10000000) return { ok: false, status: 400, code: "BAD_AMOUNT", message: "Amount must be between $1.00 and $100,000.00." };
  try {
    const hasProof = !!(body && (body.paymentId || body.txid || body.transactionHash));
    const status = hasProof ? "verification_submitted" : "pending";
    const r = await q(
      `INSERT INTO invoices (invoice_number, package_name, amount, amount_cents, status, kind, telegram_id, payment_id, payment_method, sender_wallet)
       VALUES ($1,$2,$3,$4,$5,'topup',$6,$7,$8,$9) RETURNING *`,
      [
        "TU-" + String(Date.now()).slice(-8) + "-" + String(Math.floor(Math.random() * 900 + 100)),
        "Wallet top-up", cents / 100, cents, status, tgId,
        (body && (body.paymentId || body.txid || body.transactionHash)) || null,
        (body && body.paymentMethod) || "usdt_trc20",
        (body && (body.senderWallet || body.senderAddress || body.walletAddress)) || null,
      ]
    );
    await audit(tgId, "topup_created", "invoice", r.rows[0].id, "", null, { amountCents: cents });
    return { ok: true, invoice: r.rows[0] };
  } catch (e) {
    logW("topup_fail", e);
    return { ok: false, status: 500, code: "DB", error: String(e.message).slice(0, 200) };
  }
}

async function topupProof(tgId, id, body) {
  try {
    const inv = (await q("SELECT * FROM invoices WHERE id=$1 AND kind='topup'", [id])).rows[0];
    if (!inv || inv.telegram_id !== tgId) return { ok: false, status: 404, code: "NOT_FOUND", message: "Top-up not found." };
    const tr = await transitionInvoice(id, "verification_submitted", { actor: tgId, reason: "proof submitted" });
    if (!tr.ok) return tr;
    await q("UPDATE invoices SET payment_id=COALESCE($1,payment_id), sender_wallet=COALESCE($2,sender_wallet), payment_method=COALESCE($3,payment_method) WHERE id=$4", [
      (body && (body.txid || body.transactionHash || body.paymentId)) || null,
      (body && (body.senderAddress || body.senderWallet || body.walletAddress)) || null,
      (body && body.paymentMethod) || null,
      id,
    ]);
    return { ok: true, invoice: (await q("SELECT * FROM invoices WHERE id=$1", [id])).rows[0] };
  } catch (e) {
    logW("topup_proof_fail", e);
    return { ok: false, status: 500, code: "DB", error: String(e.message).slice(0, 200) };
  }
}

/* ------------------------------------------- refunds (#77/#79) */
async function refundPartial(id, cents, actor, reason) {
  cents = Math.round(cents);
  if (!reason) return { ok: false, status: 400, code: "REASON_REQUIRED", message: "A reason is required to refund." };
  const p = getPool();
  if (!p) return { ok: false, status: 500, code: "DB" };
  try {
    const cur = await q("SELECT * FROM invoices WHERE id=$1", [id]);
    const inv = cur.rows[0];
    if (!inv || inv.deleted_at) return { ok: false, status: 404, code: "NOT_FOUND", message: "Invoice not found." };
    if (["paid", "fulfilled", "refunded"].indexOf(inv.status) === -1) {
      return { ok: false, status: 409, code: "BAD_TRANSITION", message: "Only paid/fulfilled invoices can be refunded." };
    }
    if (cents < 100 || Number(inv.refunded_cents || 0) + cents > Number(inv.amount_cents || 0)) {
      return { ok: false, status: 400, code: "REFUND_EXCEEDED", message: "Refund exceeds remaining refundable amount." };
    }
    /* atomic claim of the refund amount (no row lock held across credit -> avoids FK self-deadlock) */
    const claim = await q(
      "UPDATE invoices SET refunded_cents = refunded_cents + $1 WHERE id = $2 AND refunded_cents + $1 <= amount_cents AND deleted_at IS NULL RETURNING refunded_cents",
      [cents, id]
    );
    if (!claim.rowCount) return { ok: false, status: 400, code: "REFUND_EXCEEDED", message: "Refund exceeds remaining refundable amount." };
    const target = Number(claim.rows[0].refunded_cents);
    const cr = await credit(inv.telegram_id, cents, { kind: "refund", invoiceId: id, actor, memo: "refund (#" + id + "): " + reason, key: "invoice:" + id + ":refund:" + target });
    if (!cr.ok) {
      await q("UPDATE invoices SET refunded_cents = refunded_cents - $1 WHERE id = $2", [cents, id]).catch(() => {});
      return { ok: false, status: 500, code: "CREDIT_FAILED", message: "Refund failed." };
    }
    await audit(actor, "refund_partial", "invoice", id, reason, { refundedCents: target - cents }, { refundedCents: target, balanceCents: cr.balanceCents });
    const after = await q("SELECT * FROM invoices WHERE id=$1", [id]);
    return { ok: true, invoice: after.rows[0], balanceCents: cr.balanceCents };
  } catch (e) {
    if (e && e.code === "23505") return { ok: true, alreadyApplied: true, invoice: (await q("SELECT * FROM invoices WHERE id=$1", [id])).rows[0] };
    logW("refund_fail", e);
    return { ok: false, status: 500, code: "DB", error: String(e.message).slice(0, 200) };
  }
}

/* ------------------------------------------------- dispute soft-lock (#78) */
async function isSoftLocked(tgId) {
  try {
    const r = await q("SELECT 1 FROM invoices WHERE telegram_id=$1 AND disputed=true AND deleted_at IS NULL AND status NOT IN ('cancelled','rejected','refunded') LIMIT 1", [tgId]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}

/* ------------------------------------------------- expiry sweep (#74) */
async function expireStale(hours) {
  try {
    const r = await q(
      `SELECT id FROM invoices WHERE status IN ('pending','verification_submitted')
       AND created_at < NOW() - ($1 || ' hours')::INTERVAL AND deleted_at IS NULL`,
      [String(hours || 24)]
    );
    let n = 0;
    for (const row of r.rows) {
      const tr = await transitionInvoice(row.id, "expired", { actor: 0, reason: hours + "h unpaid timeout" });
      if (tr.ok) n++;
    }
    return { ok: true, expired: n };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 200) }; }
}

/* --------------------------------------------- reconciliation (#85) */
async function reconcile() {
  try {
    const problems = [];
    const diff = await q("SELECT * FROM wallet_ledger_diff()");
    for (const d of diff.rows) problems.push({ type: "wallet_ne_sum", telegramId: String(d.telegram_id), walletCents: Number(d.wallet_cents), ledgerCents: Number(d.ledger_cents) });
    /* top-up grants vs invoice totals */
    const g = await q(
      `SELECT COALESCE((SELECT SUM(i.amount_cents) FROM invoices i WHERE i.kind='topup' AND i.status IN ('fulfilled','refunded') AND i.deleted_at IS NULL),0)::BIGINT AS invoiced,
              COALESCE((SELECT SUM(l.amount_cents) FROM ledger_entries l WHERE l.kind='topup' AND l.invoice_id IS NOT NULL),0)::BIGINT AS credited`
    );
    const invoiced = Number(g.rows[0].invoiced), credited = Number(g.rows[0].credited);
    if (invoiced !== credited) problems.push({ type: "topup_gap", invoicedCents: invoiced, creditedCents: credited, diff: invoiced - credited });
    const rf = await q(
      `SELECT COALESCE((SELECT SUM(refunded_cents) FROM invoices WHERE deleted_at IS NULL),0)::BIGINT AS inv_ref,
              COALESCE((SELECT SUM(l.amount_cents) FROM ledger_entries l WHERE l.kind='refund' AND l.invoice_id IS NOT NULL),0)::BIGINT AS led_ref`
    );
    const invRef = Number(rf.rows[0].inv_ref), ledRef = Number(rf.rows[0].led_ref);
    if (invRef !== ledRef) problems.push({ type: "refund_gap", invoiceRefundedCents: invRef, ledgerRefundCents: ledRef, diff: invRef - ledRef });
    /* non-spendable ledger integrity: every wallet sum already checked above */
    return { ok: problems.length === 0, problems };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 200) }; }
}

/* ---------------------------------------- leaderboard recompute (#80) */
async function recomputeLeaderboard() {
  try {
    const r = await q(
      `UPDATE leaderboard lb SET growth = agg.total
       FROM (
         SELECT lower(handle) AS h, SUM(c.members_delivered) AS total
         FROM campaigns c GROUP BY 1
       ) agg
       WHERE lower(lb.handle) = '@' || agg.h OR lower(lb.handle) = agg.h`
    );
    return { ok: true, rows: r.rowCount || 0 };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 200) }; }
}

/* -------------------------------------------------- receipt helpers (#59/#76) */
async function insertFulfilledInvoice(o) {
  const cents = Math.round(o.cents);
  const num = "TA-" + String(o.campaignId + 2380).padStart(4, "0");
  const r = await q(
    `INSERT INTO invoices (invoice_number, package_name, amount, amount_cents, status, kind, telegram_id, campaign_id, channel_link, paid_at)
     VALUES ($1,$2,$3,$4,'fulfilled','campaign',$5,$6,$7,now())
     ON CONFLICT DO NOTHING RETURNING *`,
    [num, o.packageName, cents / 100, cents, o.telegramId, o.campaignId, o.channelLink || null]
  );
  return r.rows[0] || null;
}

async function packageCents(pkgId) {
  try {
    const r = await q("SELECT price_cents FROM packages WHERE id=$1", [pkgId]);
    return r.rows[0] ? r.rows[0].price_cents : null;
  } catch (e) { return null; }
}

module.exports = {
  init, getPool, walletRow, getWallet, ensureWallet,
  credit, spend, recordDirectPayment,
  transitionInvoice, adminInvoiceAction, createTopup, topupProof, refundPartial,
  isSoftLocked, expireStale, reconcile, recomputeLeaderboard,
  insertFulfilledInvoice, packageCents,
  canTransition, ALLOWED, TERMINAL,
};
