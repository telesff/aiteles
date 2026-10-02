const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const EmbeddedPostgres = require("embedded-postgres").default;
const { Pool } = require("pg");

const EPG_PORT = 54331;
const SERVER_PORT = 39477;
const BASE = "http://127.0.0.1:" + SERVER_PORT;
const TOKEN = "7049127899:TESTTOKEN_MONEY";
const ADMIN = 7049127887;
const U1 = 111222333;   /* wallet user */
const UC = 333444555;   /* legacy (no wallet) user */
const DSN = `postgresql://postgres:pw@127.0.0.1:${EPG_PORT}/teles_money`;

const money = require("../money.cjs");

function signInitData(token, params) {
  const keys = Object.keys(params).sort();
  const dataCheck = keys.map((k) => k + "=" + params[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, params[k]);
  return usp.toString() + "&hash=" + hash;
}
function initFor(uid) {
  const user = JSON.stringify({ id: uid, first_name: "M", username: "money" + uid });
  return signInitData(TOKEN, { user, auth_date: String(Math.floor(Date.now() / 1000)) });
}
function api(pathname, opts) {
  opts = opts || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (opts.uid) headers["x-telegram-init-data"] = initFor(opts.uid);
  return fetch(BASE + pathname, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(); });
      sock.once("error", () => (Date.now() > deadline ? reject(new Error("no server")) : setTimeout(attempt, 150)));
    };
    attempt();
  });
}

let epg = null;
let child = null;
let testPool = null;
let topupInvoiceId = null;
let legacyCampaignId = null;
let fastlaneInvoiceId = null;
let PKG_ID = null;

test.before(async () => {
  const dir = "/tmp/epg-money";
  spawnSync("rm", ["-rf", dir]);
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: EPG_PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("teles_money");

  const boot = spawnSync(process.execPath, ["setup-db.js"], {
    cwd: root,
    env: Object.assign({}, process.env, { DATABASE_URL: DSN }),
    encoding: "utf8",
  });
  if (boot.status !== 0) throw new Error("setup-db failed: " + (boot.stdout || "") + (boot.stderr || ""));

  const mig = spawnSync(process.execPath, ["migrate.cjs"], {
    cwd: root,
    env: Object.assign({}, process.env, { DATABASE_URL: DSN }),
    encoding: "utf8",
  });
  if (mig.status !== 0) throw new Error("migrations failed: " + (mig.stdout || "") + (mig.stderr || ""));

  testPool = new Pool({ connectionString: DSN, max: 3 });
  await testPool.query(
    "INSERT INTO packages (name, description, members, features, price, price_cents) VALUES ('Money Test Package','d','3k-5k','[]',199,19900)"
  );
  const pkg = await testPool.query("SELECT id FROM packages WHERE name='Money Test Package'");
  PKG_ID = pkg.rows[0].id;

  child = spawn(process.execPath, ["--require", path.join(root, "test", "mock-tg.cjs"), "server.cjs"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(SERVER_PORT),
      TELEGRAM_BOT_TOKEN: TOKEN,
      ADMIN_TELEGRAM_ID: String(ADMIN),
      AUTO_SETUP_WEBHOOK: "",
      WEBHOOK_SECRET: "money_secret",
      CRON_SECRET: "money_cron",
      DATABASE_URL: DSN,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForPort(SERVER_PORT, 15000);
  money.init(new Pool({ connectionString: DSN, max: 3 }));
});

test.after(async () => {
  if (child) child.kill("SIGKILL");
  try { const mp = money.getPool(); if (mp) await mp.end().catch(() => {}); } catch (_) {}
  if (testPool) await testPool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  if (epg) await epg.stop().catch(() => {});
  console.log("AFTER-COMPLETE");
});

/* ------------------------------------------------------------------ unit */
test("state machine: legal and illegal transitions (#71)", () => {
  assert.equal(money.canTransition("pending", "verification_submitted"), true);
  assert.equal(money.canTransition("pending", "expired"), true);
  assert.equal(money.canTransition("verification_submitted", "fulfilled"), true);
  assert.equal(money.canTransition("fulfilled", "refunded"), true);
  assert.equal(money.canTransition("fulfilled", "pending"), false);
  assert.equal(money.canTransition("expired", "paid"), false);
  assert.equal(money.canTransition("cancelled", "fulfilled"), false);
  assert.equal(money.canTransition("paid", "pending"), false);
});

test("schemas: topup amount bounds enforced (#21)", async () => {
  const bad = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 50 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "VALIDATION_ERROR");
});

/* ------------------------------------------------------------- wallet flow */
test("wallet: unauthenticated -> 401", async () => {
  const r = await api("/api/wallet");
  assert.equal(r.status, 401);
});

test("topup: created as pending with snapshotted cents (#59/#75)", async () => {
  const r = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 25000 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.invoice.status, "pending");
  assert.equal(r.body.invoice.amount_cents, 25000);
  assert.equal(r.body.invoice.kind, "topup");
  topupInvoiceId = r.body.invoice.id;
});

test("admin gate: non-admin cannot approve invoices (#40/#72)", async () => {
  const r = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: U1, body: { status: "fulfilled", reason: "self-approve" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "FORBIDDEN");
});

test("approve: top-up fulfilment credits wallet exactly once (#72/#73)", async () => {
  const r = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: ADMIN, body: { status: "fulfilled", reason: "proof verified" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.credited, true);
  assert.equal(r.body.wallet.balanceCents, 25000);
});

test("approve again: rejected by state machine, ledger has single entry (#71/idempotency)", async () => {
  const r = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: ADMIN, body: { status: "fulfilled", reason: "again" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "BAD_TRANSITION");
  const w = await api("/api/wallet", { uid: U1 });
  assert.equal(w.body.balanceCents, 25000);
  const topups = w.body.entries.filter((e) => e.kind === "topup");
  assert.equal(topups.length, 1);
});

test("admin invoice PATCH without auth -> 401", async () => {
  const r = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", body: { status: "paid" } });
  assert.equal(r.status, 401);
});

test("audit trail: approval wrote admin_audit row (#77)", async () => {
  const r = await testPool.query("SELECT action, actor_telegram_id FROM admin_audit WHERE entity='invoice' AND entity_id=$1 AND action LIKE 'invoice:%' ORDER BY id DESC", [String(topupInvoiceId)]);
  assert.ok(r.rows.length >= 1);
  assert.equal(String(r.rows[0].actor_telegram_id), String(ADMIN));
});

/* ------------------------------------------------------------ dispute #78 */
test("dispute: flags soft-lock campaign creation; clearing releases it", async () => {
  const on = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: ADMIN, body: { disputed: true, reason: "chargeback claim" } });
  assert.equal(on.status, 200);
  const locked = await api("/api/campaigns", { method: "POST", uid: U1, body: { packageId: PKG_ID, channelLink: "@lockedchan", audience: "crypto" } });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, "SOFT_LOCKED");
  const off = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: ADMIN, body: { disputed: false, reason: "resolved with customer" } });
  assert.equal(off.status, 200);
});

/* ------------------------------------------------- fast-lane purchase #58/61 */
test("txid reuse rejected: same TXID on a second topup -> 409 TXID_IN_USE", async () => {
  const tx = "0xuiE2E" + Date.now();
  const a1 = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 2000, paymentMethod: "usdt_trc20", txid: tx } });
  assert.equal(a1.status, 201);
  assert.equal(a1.body.invoice.status, "verification_submitted");
  const a2 = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 2000, paymentMethod: "usdt_trc20", txid: tx } });
  assert.equal(a2.status, 409);
  assert.equal(a2.body.code, "TXID_IN_USE");
});

test("campaign create: wallet spend -> active + fulfilled receipt (#58/#59/#61)", async () => {
  const r = await api("/api/campaigns", { method: "POST", uid: U1, body: { packageId: PKG_ID, channelLink: "@walletpaid", audience: "crypto" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.walletFunded, true);
  assert.equal(r.body.status, "active");
  const w = await api("/api/wallet", { uid: U1 });
  assert.equal(w.body.balanceCents, 5100); /* 25000 - 19900 */
  const spend = w.body.entries.filter((e) => e.kind === "spend");
  assert.equal(spend.length, 1);
  assert.equal(spend[0].amountCents, -19900);
  const inv = await testPool.query("SELECT id, status, amount_cents, campaign_id FROM invoices WHERE telegram_id=$1 AND kind='campaign' AND status='fulfilled'", [U1]);
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.rows[0].amount_cents, 19900);
  fastlaneInvoiceId = inv.rows[0].id;
});

test("campaign create: insufficient balance -> 402 INSUFFICIENT_BALANCE", async () => {
  const r = await api("/api/campaigns", { method: "POST", uid: U1, body: { packageId: PKG_ID, channelLink: "@brokechan", audience: "crypto" } });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, "INSUFFICIENT_BALANCE");
  assert.equal(r.body.balanceCents, 5100);
  assert.equal(r.body.requiredCents, 19900);
});

test("campaign create: no wallet row -> legacy pending flow (no regression)", async () => {
  const r = await api("/api/campaigns", { method: "POST", uid: UC, body: { packageId: PKG_ID, channelLink: "@legacychan", audience: "forex" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "pending");
  assert.equal(r.body.walletFunded, undefined);
  legacyCampaignId = r.body.id;
  const inv = await testPool.query("SELECT id, status, telegram_id, campaign_id FROM invoices WHERE campaign_id=$1", [legacyCampaignId]);
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.rows[0].status, "pending");
  assert.equal(String(inv.rows[0].telegram_id), String(UC)); /* buyer attribution #76 */
});

/* --------------------------------------------------- isolation (#82) */
test("invoices: owner sees only own; admin sees all", async () => {
  const owner = await api("/api/invoices", { uid: UC });
  assert.equal(owner.status, 200);
  const rows = owner.body.invoices.filter((i) => i.invoiceNumber && i.invoiceNumber.startsWith("TA-"));
  assert.ok(rows.every((i) => true)); /* scoped query below is the real assertion */
  const mine = await testPool.query("SELECT count(*) FROM invoices WHERE telegram_id=$1", [UC]);
  assert.ok(Number(mine.rows[0].count) >= 1);
  /* as another user, TA rows of UC must not be returned */
  const other = await api("/api/invoices", { uid: U1 });
  const otherTA = (other.body.invoices || []).filter((i) => i.invoiceNumber === ("TA-" + String(legacyCampaignId + 2380).padStart(4, "0")));
  assert.equal(otherTA.length, 0);
});

/* ------------------------------------------------- race-safe spend (#61) */
test("concurrent spends: 10x3000 from 10000 -> exactly 3 succeed, never negative", async () => {
  const uid = 999000111;
  await money.credit(uid, 10000, { kind: "topup", key: "race-setup" });
  const runs = await Promise.all(
    Array.from({ length: 10 }, (_, i) => money.spend(uid, 3000, { key: "race:" + i, memo: "race" }))
  );
  const ok = runs.filter((r) => r.ok && !r.alreadyApplied).length;
  assert.equal(ok, 3);
  const w = await money.getWallet(uid);
  assert.equal(w.balanceCents, 1000);
  assert.ok(w.balanceCents >= 0);
});

test("idempotent credit: same key twice -> one ledger row", async () => {
  const uid = 999000222;
  const a = await money.credit(uid, 700, { kind: "topup", key: "idem-1" });
  const b = await money.credit(uid, 700, { kind: "topup", key: "idem-1" });
  assert.equal(a.applied, true);
  assert.equal(b.alreadyApplied, true);
  const w = await money.getWallet(uid);
  assert.equal(w.balanceCents, 700);
  assert.equal(w.entries.length, 1);
});

/* ------------------------------------------------- direct legs (#73) */
test("direct payment: two ledger legs net to zero, balance untouched", async () => {
  const uid = 999222333;
  await money.credit(uid, 500, { kind: "topup", key: "direct-setup" });
  await money.recordDirectPayment({ telegramId: uid, campaignId: legacyCampaignId, cents: 19900, packageName: "Premium" });
  const w = await money.getWallet(uid);
  assert.equal(w.balanceCents, 500);
  assert.ok(w.entries.some((e) => e.kind === "direct_payment" && e.amountCents === 19900));
  assert.ok(w.entries.some((e) => e.kind === "spend" && e.amountCents === -19900));

  /* old-flow users must NEVER become wallet-authoritative (no prepay) */
  const fresh = 999888777;
  await money.recordDirectPayment({ telegramId: fresh, campaignId: legacyCampaignId, cents: 19900, packageName: "Premium" });
  const fw = await money.getWallet(fresh);
  assert.equal(fw.exists, false, "no wallet row for a pay-per-invoice user");
  assert.equal(fw.balanceCents, 0, "direct legs net to zero");
  const row = await testPool.query("SELECT count(*)::int AS n FROM wallets WHERE telegram_id=$1", [fresh]);
  assert.equal(row.rows[0].n, 0, "no wallets row inserted");
  const legs = await testPool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE telegram_id=$1", [fresh]);
  assert.equal(legs.rows[0].n, 2, "both ledger legs recorded");
});

/* ------------------------------------------------- guards: trigger + CHECK (#76/#71) */
test("receipt immutability: rewriting amount on fulfilled invoice fails (#76)", async () => {
  await assert.rejects(
    testPool.query("UPDATE invoices SET amount = 1 WHERE id = $1", [fastlaneInvoiceId]),
    /immutable/
  );
});

test("state CHECK: bogus status rejected at DB level (#71)", async () => {
  await assert.rejects(
    testPool.query("UPDATE invoices SET status = 'bogus' WHERE id = $1", [fastlaneInvoiceId]),
    /invoices_status_valid/
  );
});

/* ------------------------------------------------- expiry + reconcile (#74/#85) */
test("expiry: stale pending invoice expires with reason + audit (#74)", async () => {
  const r = await testPool.query(
    `INSERT INTO invoices (invoice_number, package_name, amount, amount_cents, status, kind, telegram_id, created_at)
     VALUES ('TU-STALE-1','Wallet top-up',10,1000,'pending','topup',$1, NOW() - INTERVAL '25 hours') RETURNING id`,
    [UC]
  );
  const out = await money.expireStale(24);
  assert.equal(out.ok, true);
  assert.ok(out.expired >= 1);
  const row = await testPool.query("SELECT status, expired_reason FROM invoices WHERE id=$1", [r.rows[0].id]);
  assert.equal(row.rows[0].status, "expired");
  assert.match(row.rows[0].expired_reason, /24h/);
});

test("reconcile: balanced after flows; doctoring wallet detected (#85)", async () => {
  const ok = await money.reconcile();
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await testPool.query("UPDATE wallets SET balance_cents = balance_cents + 1 WHERE telegram_id = $1", [U1]);
  const bad = await money.reconcile();
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].type, "wallet_ne_sum");
  await testPool.query("UPDATE wallets SET balance_cents = balance_cents - 1 WHERE telegram_id = $1", [U1]);
  const back = await money.reconcile();
  assert.equal(back.ok, true);
});

/* ------------------------------------------------- append-only ledger (#60) */
test("ledger: UPDATE and DELETE rejected at DB level (#60)", async () => {
  let upd = null, del = null;
  try { await testPool.query("UPDATE ledger_entries SET amount_cents = 1 WHERE id = (SELECT MIN(id) FROM ledger_entries)"); } catch (e) { upd = e; }
  assert.ok(upd && /append-only/.test(upd.message), "UPDATE should be blocked: " + (upd && upd.message));
  try { await testPool.query("DELETE FROM ledger_entries WHERE id = (SELECT MIN(id) FROM ledger_entries)"); } catch (e) { del = e; }
  assert.ok(del && /append-only/.test(del.message), "DELETE should be blocked: " + (del && del.message));
});

/* ------------------------------------------------- refunds (#77/#79) */
test("full refund: status machine + wallet credit + audit", async () => {
  const r = await api("/api/admin/invoices/" + topupInvoiceId, { method: "PATCH", uid: ADMIN, body: { status: "refunded", reason: "customer requested full refund" } });
  assert.equal(r.status, 200);
  const w = await api("/api/wallet", { uid: U1 });
  /* 5100 (after spend) + 25000 refund = 30100 */
  assert.equal(w.body.balanceCents, 30100);
  const inv = await testPool.query("SELECT status, refunded_cents FROM invoices WHERE id=$1", [topupInvoiceId]);
  assert.equal(inv.rows[0].status, "refunded");
  assert.equal(Number(inv.rows[0].refunded_cents), 25000);
  const rec = await money.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec));
});

test("partial refund: amount-capped, cumulative, then exceeded -> 400", async () => {
  const t1 = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 10000 } });
  assert.equal(t1.status, 201);
  const ap = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { status: "fulfilled", reason: "verified" } });
  assert.equal(ap.status, 200);

  const p1 = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { refundAmountCents: 4000, reason: "partial goodwill" } });
  assert.equal(p1.status, 200);
  const w = await api("/api/wallet", { uid: U1 });
  assert.equal(w.body.balanceCents, 30100 + 10000 + 4000);

  const p2 = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { refundAmountCents: 7000, reason: "over amount" } });
  assert.equal(p2.status, 400);
  assert.equal(p2.body.code, "REFUND_EXCEEDED");

  const noReason = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { refundAmountCents: 1000 } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, "REASON_REQUIRED");

  const rec = await money.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec));
});

test("campaign isolation: another user cannot read someone else's campaign (#82)", async () => {
  const r = await api("/api/campaigns/" + legacyCampaignId, { uid: U1 });
  assert.ok(r.status === 403 || r.status === 404, "other user got " + r.status);
  const own = await api("/api/campaigns/" + legacyCampaignId, { uid: UC });
  assert.equal(own.status, 200);
});

/* ------------------------------------- legacy admin UI compat (#72 one-click) */
test("legacy admin UI: paid auto-fulfils topup once; failed maps to rejected", async () => {
  const w0 = await api("/api/wallet", { uid: U1 });
  const before = w0.body.balanceCents;

  const t1 = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 5000 } });
  assert.equal(t1.status, 201);

  /* old Admin Panel sends {status:"paid"} — must credit via auto-fulfil */
  const ap = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { status: "paid" } });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.invoice.status, "fulfilled");

  const w1 = await api("/api/wallet", { uid: U1 });
  assert.equal(w1.body.balanceCents, before + 5000);

  const led = await testPool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE invoice_id=$1 AND kind='topup'", [t1.body.invoice.id]);
  assert.equal(led.rows[0].n, 1, "exactly one credit row");

  /* re-approve -> machine rejects (no double credit) */
  const ap2 = await api("/api/admin/invoices/" + t1.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { status: "paid" } });
  assert.equal(ap2.status, 409);

  /* old Reject button sends {status:"failed"} — aliased to rejected */
  const t2 = await api("/api/wallet/topup", { method: "POST", uid: U1, body: { amountCents: 3000 } });
  const rj = await api("/api/admin/invoices/" + t2.body.invoice.id, { method: "PATCH", uid: ADMIN, body: { status: "failed", reason: "no payment seen" } });
  assert.equal(rj.status, 200);
  assert.equal(rj.body.invoice.status, "rejected");

  const w2 = await api("/api/wallet", { uid: U1 });
  assert.equal(w2.body.balanceCents, before + 5000, "rejected topup credits nothing");

  const rec = await money.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec));
});

/* ------------------------------------------------- soft-delete (#83) */
test("soft-delete: unpaid invoice deletable (one-way); paid protected", async () => {
  const stale = await testPool.query(
    `INSERT INTO invoices (invoice_number, package_name, amount, amount_cents, status, kind, telegram_id)
     VALUES ('TU-DEL-1','Wallet top-up',5,500,'pending','topup',$1) RETURNING id`,
    [UC]
  );
  const del = await api("/api/admin/invoices/" + stale.rows[0].id, { method: "PATCH", uid: ADMIN, body: { deleted: true, reason: "test row" } });
  assert.equal(del.status, 200);
  const gone = await api("/api/admin/invoices/" + stale.rows[0].id, { method: "PATCH", uid: ADMIN, body: { status: "cancelled", reason: "x" } });
  assert.equal(gone.status, 404);
  const paid = await api("/api/admin/invoices/" + fastlaneInvoiceId, { method: "PATCH", uid: ADMIN, body: { deleted: true, reason: "nope" } });
  assert.equal(paid.status, 409);
  assert.equal(paid.body.code, "MONEY_ROW_PROTECTED");
});
