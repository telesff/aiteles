const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");

const sn = require("../start-notify.cjs");
const root = path.resolve(__dirname, "..");

process.env.ADMIN_TELEGRAM_ID = "7049127887";
process.env.ADMIN_IDS = "";

const ADMIN = 7049127887;

test("buildText: user-controlled fields are HTML-escaped (#53/#54)", () => {
  const t = sn.buildText(
    "start",
    { id: 123, first_name: '<b>Evil</b>&"x"', last_name: "<script>alert(1)</script>", username: "a<b", language_code: "en" },
    'ref_<img>',
    null,
    123
  );
  assert.ok(!t.includes("<script>"));
  assert.ok(!t.includes("<b>Evil"));
  assert.ok(t.includes("&lt;script&gt;"));
  assert.ok(t.includes("ref_&lt;img&gt;"));
  assert.ok(t.includes("123"));
  assert.ok(t.includes("@a&lt;b"));
});

test("notifyUserStart: sends to admin with full details", async () => {
  const calls = [];
  const res = await sn.notifyUserStart({
    kind: "start",
    from: { id: 555001, first_name: "Test", last_name: "User", username: "testuser", language_code: "en", is_premium: true },
    startParam: "ref_42",
    chatId: 555001,
    dbUser: [{ telegramId: 555001, createdAt: "2026-01-05T00:00:00Z", lastLoginAt: "2026-09-30T10:00:00Z" }],
    send: async (chatId, text) => { calls.push({ chatId, text }); },
    now: 1000000,
  });
  assert.equal(res.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, ADMIN);
  const t = calls[0].text;
  assert.ok(t.includes("/start"));
  assert.ok(t.includes("555001"));
  assert.ok(t.includes("@testuser"));
  assert.ok(t.includes("Test User"));
  assert.ok(t.includes("ref_42"));
  assert.ok(t.includes("joined 2026-01-05"));
  assert.ok(t.includes("Premium") && t.includes("yes"));
});

test("notifyUserStart: unregistered visitor labeled correctly", async () => {
  const calls = [];
  await sn.notifyUserStart({
    kind: "agent",
    from: { id: 555002, first_name: "BotOnly" },
    send: async (c, t) => calls.push(t),
    dbUser: [],
    now: 2000000,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/agent"));
  assert.ok(calls[0].includes("not registered yet"));
});

test("notifyUserStart: admin's own start is not echoed back (self skip)", async () => {
  const calls = [];
  const res = await sn.notifyUserStart({
    kind: "start",
    from: { id: ADMIN, first_name: "Admin" },
    send: async (c, t) => calls.push(t),
    now: 3000000,
  });
  assert.equal(res.skipped, "self");
  assert.equal(calls.length, 0);
});

test("notifyUserStart: 20s dedupe — duplicate start inside window skipped", async () => {
  const calls = [];
  const base = 4000000;
  const r1 = await sn.notifyUserStart({ kind: "start", from: { id: 555003, first_name: "A" }, send: async (c, t) => calls.push(t), now: base });
  const r2 = await sn.notifyUserStart({ kind: "agent", from: { id: 555003, first_name: "A" }, send: async (c, t) => calls.push(t), now: base + 5000 });
  const r3 = await sn.notifyUserStart({ kind: "start", from: { id: 555003, first_name: "A" }, send: async (c, t) => calls.push(t), now: base + 21000 });
  assert.equal(r1.sent, 1);
  assert.equal(r2.skipped, "dedupe");
  assert.equal(r3.sent, 1);
  assert.equal(calls.length, 2);
});

test("notifyUserStart: send failure never throws (start flow protected)", async () => {
  const res = await sn.notifyUserStart({
    kind: "start",
    from: { id: 555004, first_name: "B" },
    send: async () => { throw new Error("network down"); },
    now: 5000000,
  });
  assert.equal(res.sent, 0);
});

test("notifyUserStart: missing send fn -> skipped, no throw", async () => {
  const res = await sn.notifyUserStart({ kind: "start", from: { id: 555005 }, now: 6000000 });
  assert.equal(res.skipped, "no-send");
});

test("notifyUserStart: dbUser promise rejection tolerated", async () => {
  const calls = [];
  const res = await sn.notifyUserStart({
    kind: "signup",
    from: { id: 555006, first_name: "C" },
    send: async (c, t) => calls.push(t),
    dbUser: Promise.reject(new Error("db down")),
    now: 7000000,
  });
  assert.equal(res.sent, 1);
  assert.ok(calls[0].includes("not registered yet"));
});

test("adminIds: comma ADMIN_IDS adds extra targets", () => {
  process.env.ADMIN_TELEGRAM_ID = "111";
  process.env.ADMIN_IDS = "222, 333,111";
  const ids = sn.adminIds();
  assert.deepEqual(ids, [111, 222, 333]);
  process.env.ADMIN_TELEGRAM_ID = "7049127887";
  process.env.ADMIN_IDS = "";
  sn._seen.clear();
});

/* -------------------------------------------------- integration: webhook */
const PORT = 39476;
const BASE = "http://127.0.0.1:" + PORT;
const TOKEN = "7049127899:TESTTOKEN_STARTNOTIFY";
const WEBHOOK_SECRET = "startnotify_secret_0123456789";

function signInitData(token, params) {
  const keys = Object.keys(params).sort();
  const dataCheck = keys.map((k) => k + "=" + params[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, params[k]);
  return usp.toString() + "&hash=" + hash;
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(); });
      sock.once("error", () => {
        if (Date.now() > deadline) reject(new Error("no server"));
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
      CRON_SECRET: "cron_sn",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:59999/teles_sn",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForPort(PORT, 12000);
});

test.after(() => { if (child) { child.kill("SIGKILL"); child = null; } });

test("webhook: /start update accepted (notify path executes, failures swallowed)", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    body: JSON.stringify({
      message: {
        message_id: 1,
        chat: { id: 666001, type: "private" },
        from: { id: 666001, first_name: "Live", username: "liveuser", language_code: "en" },
        text: "/start",
      },
    }),
  });
  assert.equal(res.status, 200);
});

test("webhook: /agent update accepted (agent-notify hook ran before AI handler)", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    body: JSON.stringify({
      message: {
        message_id: 2,
        chat: { id: 666002, type: "private" },
        from: { id: 666002, first_name: "AgentUser" },
        text: "/agent",
      },
    }),
  });
  assert.equal(res.status, 200);
});

test("webhook: normal message unaffected by notify hooks", async () => {
  const res = await fetch(BASE + "/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    body: JSON.stringify({
      message: { message_id: 3, chat: { id: 666003, type: "private" }, from: { id: 666003, first_name: "X" }, text: "hello there" },
    }),
  });
  assert.equal(res.status, 200);
});
