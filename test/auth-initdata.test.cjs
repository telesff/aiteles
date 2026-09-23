const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");

const root = path.resolve(__dirname, "..");
const PORT = 39471;
const TOKEN = "7049127899:TESTTOKEN_AUTHSUITE_ONLY";
const BASE = "http://127.0.0.1:" + PORT;

/* initData signer — mirrors Telegram's documented scheme:
   data_check_string = decoded "key=value" lines joined by \n (NOT url-encoded);
   the header transport itself carries url-encoded pairs. */
function signInitData(token, params) {
  const keys = Object.keys(params).sort();
  const dataCheck = keys.map((k) => k + "=" + params[k]).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const usp = new URLSearchParams();
  for (const k of keys) usp.append(k, params[k]);
  return usp.toString() + "&hash=" + hash;
}

const USER_A = JSON.stringify({ id: 7049127887, first_name: "Alice", username: "alice" });
const USER_B = JSON.stringify({ id: 9999999999, first_name: "Mallory", username: "mallory" });

const BODY = {
  packageId: 1,
  channelLink: "@somechannel",
  audience: "crypto",
};

function postCampaign(initData) {
  const headers = { "Content-Type": "application/json" };
  if (initData != null) headers["x-telegram-init-data"] = initData;
  return fetch(BASE + "/api/campaigns", {
    method: "POST",
    headers,
    body: JSON.stringify(BODY),
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(); });
      sock.once("error", () => {
        if (Date.now() > deadline) reject(new Error("server did not start"));
        else setTimeout(attempt, 150);
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
      /* bundle requires DATABASE_URL at load; unreachable DSN = queries fail
         at request time (500), which is exactly what these auth tests assert */
      DATABASE_URL: "postgresql://test:test@127.0.0.1:59999/teles_test",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForPort(PORT, 10000);
});

test.after(() => {
  if (child) {
    child.kill("SIGKILL");
    child = null;
  }
});

/* ------------------------------------------------------------------ (#179) */
test("auth: missing header -> 401", async () => {
  const res = await postCampaign(null);
  assert.equal(res.status, 401);
});

test("auth: garbage hash -> 401", async () => {
  const res = await postCampaign("user=%7B%22id%22%3A7049127887%7D&auth_date=1700000000&hash=deadbeef");
  assert.equal(res.status, 401);
});

test("auth: well-formed but wrong hash -> 401", async () => {
  const signed = signInitData(TOKEN, { user: USER_A, auth_date: String(Math.floor(Date.now() / 1000)) });
  const tampered = signed.replace(/hash=[0-9a-f]+$/, "hash=" + "a".repeat(64));
  const res = await postCampaign(tampered);
  assert.equal(res.status, 401);
});

test("auth: expired auth_date (>24h, valid signature) -> 401", async () => {
  const signed = signInitData(TOKEN, {
    user: USER_A,
    auth_date: String(Math.floor(Date.now() / 1000) - 90000),
  });
  const res = await postCampaign(signed);
  assert.equal(res.status, 401);
});

test("auth: altered user after signing -> 401", async () => {
  let signed = signInitData(TOKEN, {
    user: USER_A,
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const encodedA = encodeURIComponent(USER_A).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  signed = signed.replace(new RegExp(encodedA), encodeURIComponent(USER_B));
  const res = await postCampaign(signed);
  assert.equal(res.status, 401);
});

test("auth: valid signature with extra unsigned param -> 401 (#44)", async () => {
  const signed = signInitData(TOKEN, {
    user: USER_A,
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const res = await postCampaign(signed + "&evil_extra=1");
  assert.equal(res.status, 401);
});

test("auth: stale auth_date (>24h, otherwise-valid hash) -> 401 (#43)", async () => {
  const signed = signInitData(TOKEN, {
    user: USER_A,
    auth_date: String(Math.floor(Date.now() / 1000) - 90000), // ~25h old
  });
  const res = await postCampaign(signed);
  assert.equal(res.status, 401);
});

test("auth: valid signature is accepted (never 401)", async () => {
  const signed = signInitData(TOKEN, {
    user: USER_A,
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE_test",
  });
  const res = await postCampaign(signed);
  /* With auth valid the request proceeds past auth: may be 400 (guard/handler),
     201 (full path) or 500 (no DB in unit env) — but never 401/403. */
  assert.ok(res.status !== 401 && res.status !== 403, "got " + res.status);
});

test("guard: unauthenticated garbage channel still 401 (auth first, no info leak)", async () => {
  const headers = { "Content-Type": "application/json" };
  const res = await fetch(BASE + "/api/campaigns", {
    method: "POST",
    headers,
    body: JSON.stringify({ packageId: 1, channelLink: "hhjagwv", audience: "crypto" }),
  });
  assert.equal(res.status, 401);
});
