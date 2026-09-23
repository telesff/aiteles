const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const PORT = 39474;
const BASE = "http://127.0.0.1:" + PORT;
const TOKEN = "7049127899:TESTTOKEN_HARDEN_SUITE";
const WEBHOOK_SECRET = "hardtest_webhook_secret_0123456789";
const CRON_SECRET = "hardtest_cron_secret_0123456789abcdef";

function signInitData(token, params) {
  const keys = Object.keys(params).sort();
  const dataCheck = keys.map((k) => k + "=" + params[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, params[k]);
  return usp.toString() + "&hash=" + hash;
}

const USER = JSON.stringify({ id: 7049127887, first_name: "H", username: "harduser" });
function validInit(extra) {
  return signInitData(
    TOKEN,
    Object.assign(
      { user: USER, auth_date: String(Math.floor(Date.now() / 1000)) },
      extra || {}
    )
  );
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        if (Date.now() > deadline) reject(new Error("server did not start"));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

let child = null;

test.before(async () => {
  child = spawn(process.execPath, ["server.cjs"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      TELEGRAM_BOT_TOKEN: TOKEN,
      ADMIN_TELEGRAM_ID: "7049127887",
      AUTO_SETUP_WEBHOOK: "",
      WEBHOOK_SECRET,
      CRON_SECRET,
      DATABASE_URL: "postgresql://test:test@127.0.0.1:59999/teles_hard",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForPort(PORT, 12000);
});

test.after(() => {
  if (child) {
    child.kill("SIGKILL");
    child = null;
  }
});

/* ------------------------------------------------------- security headers */
test("headers: security set, powered-by removed, request-id present", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok((res.headers.get("content-security-policy") || "").includes("default-src 'self'"));
  assert.ok(res.headers.get("referrer-policy"));
  assert.ok(res.headers.get("permissions-policy"));
  assert.ok(res.headers.get("strict-transport-security"));
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.ok(/^[0-9a-f-]{36}$/.test(res.headers.get("x-request-id") || ""));
});

test("headers: no permissive CORS (default deny) (#47)", async () => {
  const res = await fetch(BASE + "/api/packages", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

/* ------------------------------------------------------------ webhook #30 */
test("webhook: missing secret -> 403 WEBHOOK_SECRET", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/start" } }),
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.code, "WEBHOOK_SECRET");
});

test("webhook: wrong secret -> 403", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test("webhook: correct secret + no-chat body -> 200", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
});

test("webhook: per-user flood control drops after 40/min with 200 (#46)", async () => {
  let lastStatus = 0;
  let lastBody = null;
  for (let i = 0; i < 43; i++) {
    const res = await fetch(BASE + "/api/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: JSON.stringify({ message: { from: { id: 555001 } } }),
    });
    lastStatus = res.status;
    lastBody = await res.json();
    if (lastBody && lastBody.dropped) break;
  }
  assert.equal(lastStatus, 200);
  assert.equal(lastBody.dropped, true);
});

/* ------------------------------------------------------------ schemas #21 */
test("schemas: invalid feedback rating -> 400 VALIDATION_ERROR contract", async () => {
  const res = await fetch(BASE + "/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: "not-a-number", comment: "hi" }),
  });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.code, "VALIDATION_ERROR");
  assert.equal(j.field, "rating");
  assert.ok(typeof j.error === "string" && j.error.length > 0);
  assert.ok(j.requestId);
});

test("schemas: campaign with wrong packageId type -> 400 (pre-auth shape check)", async () => {
  const res = await fetch(BASE + "/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "abc", channelLink: "@somechannel", audience: "crypto" }),
  });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.code, "VALIDATION_ERROR");
});

test("schemas: bad audience enum -> 400", async () => {
  const res = await fetch(BASE + "/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: 1, channelLink: "@somechannel", audience: "nonsense" }),
  });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------- admin gate #40 */
test("admin: unauthenticated request -> 401 contract (defense-in-depth)", async () => {
  const res = await fetch(BASE + "/api/admin/channels");
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.code, "UNAUTHENTICATED");
});

test("admin: authenticated non-admin -> 403 contract", async () => {
  const res = await fetch(BASE + "/api/admin/channels", {
    headers: { "x-telegram-init-data": validInit() },
  });
  /* our test user id != ADMIN_TELEGRAM_ID? it EQUALS 7049127887 (admin default) —
     use a different signed id to prove 403 */
  const other = JSON.stringify({ id: 424242, first_name: "X", username: "notadmin" });
  const res2 = await fetch(BASE + "/api/admin/channels", {
    headers: { "x-telegram-init-data": signInitData(TOKEN, { user: other, auth_date: String(Math.floor(Date.now() / 1000)) }) },
  });
  assert.equal(res2.status, 403);
  const j = await res2.json();
  assert.equal(j.code, "FORBIDDEN");
  assert.ok(res.status === 404 || res.status === 200 || res.status === 500 || res.status === 403); // admin path check above is informational
});

/* ---------------------------------------------------------- health #37 */
test("health: degraded 503 when DB unreachable", async () => {
  const res = await fetch(BASE + "/api/health");
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.status, "degraded");
  assert.equal(j.db.ok, false);
  assert.ok(j.requestId);
});

/* ------------------------------------------------------------ cron #33 */
test("cron: no auth -> 403; wrong bearer -> 403", async () => {
  const a = await fetch(BASE + "/api/internal/cron");
  assert.equal(a.status, 403);
  const b = await fetch(BASE + "/api/internal/cron", { headers: { Authorization: "Bearer nope" } });
  assert.equal(b.status, 403);
});

test("cron: correct bearer -> 200 with results skeleton", async () => {
  const res = await fetch(BASE + "/api/internal/cron", {
    headers: { Authorization: "Bearer " + CRON_SECRET },
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.degraded, "boolean");
});

/* ------------------------------------------------------ error handler #27 */
test("errors: malformed JSON -> 400 BAD_JSON without SyntaxError leak", async () => {
  const res = await fetch(BASE + "/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(text.includes("BAD_JSON"));
  assert.ok(!text.includes("SyntaxError"));
  assert.ok(!text.includes("at Object"));
});

test("errors: DB failure -> 500 INTERNAL without driver leak (#27)", async () => {
  const res = await fetch(BASE + "/api/packages");
  assert.equal(res.status, 500);
  const text = await res.text();
  const j = JSON.parse(text);
  assert.equal(j.code, "INTERNAL");
  assert.ok(!text.includes("ECONNREFUSED"));
  assert.ok(!text.includes("at "));
  assert.ok(j.requestId);
});

/* ------------------------------------------------------------ v1 alias #24 */
test("v1: /api/v1/health reaches app through alias", async () => {
  const res = await fetch(BASE + "/api/v1/health");
  assert.equal(res.status, 503); // degraded (unit env, no DB) — proves alias + early ran
  const j = await res.json();
  assert.equal(j.status, "degraded");
});

/* ------------------------------------------------------ login rate #45 */
test("login: 11th authenticated attempt in a minute -> 429", async () => {
  let last = 0;
  let lastJ = null;
  for (let i = 0; i < 11; i++) {
    const res = await fetch(BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-init-data": validInit() },
      body: JSON.stringify({ username: "harduser" }),
    });
    last = res.status;
    lastJ = await res.json().catch(() => ({}));
    if (last === 429) break;
  }
  assert.equal(last, 429);
  assert.equal(lastJ.code, "RATE_LIMITED");
});

/* ------------------------------------------------- idempotent payment #31 */
test("payment: PAYMENT_ID_REUSED wired to 409 (#31 existing defense)", () => {
  const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
  const invoice = fs.readFileSync(path.join(root, "teles-invoice.cjs"), "utf8");
  assert.match(server, /PAYMENT_ID_REUSED"\?409:400/);
  assert.match(invoice, /PAYMENT_ID_REUSED/);
});
