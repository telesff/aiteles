const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
const frontend = fs.readFileSync(
  path.join(root, "public/assets/index-DTEWTEAe.js"),
  "utf8"
);
const frontendCss = fs.readFileSync(
  path.join(root, "public/assets/index-6wOoSUvw.css"),
  "utf8"
);

test("production Telegram routing prioritizes /start", () => {
  assert.match(
    server,
    /if\(!\(i==="\/start"\|\|i\.startsWith\("\/start "\)\)&&await __telesAgent\.handleUpdate/
  );
});

test("production campaign orders use their package member target", () => {
  assert.match(server, /__telesAgent\.parseMemberTarget\(o\.members\)/);
  assert.doesNotMatch(server, /c=2e3;u&&u\.length/);
  assert.match(frontend, /Member target \(e\.g\. 5000 or 3k–5k\)/);
});

test("production platform links point to egatusad.com", () => {
  assert.match(server, /process\.env\.APP_URL\|\|"https:\/\/egatusad\.com"/);
  assert.doesNotMatch(server, /Visit telesads\.com/);
  assert.match(frontend, /value:"egatusad\.com",href:"https:\/\/egatusad\.com"/);
});

test("production Telegram routing forwards callback queries", () => {
  assert.match(server, /r\?\.callback_query\?\.message\?\.chat\?\.id/);
  assert.match(server, /r\?\.callback_query\?\.from\?\.id/);
  assert.match(server, /allowed_updates:\["message","callback_query"\]/);
});

test("production payments poll for automatic on-chain confirmation", () => {
  assert.match(server, /require\("\.\/teles-invoice\.cjs"\)/);
  assert.match(server, /__telesInvoice\.startOrCheckAutomaticPayment/);
  assert.match(server, /if\(n\.status!=="paid"\)/);
  assert.match(server, /Payment confirmed automatically/);
  assert.doesNotMatch(server, /__telesInvoice\.handlePaymentSubmission/);
  assert.match(frontend, /Automatic USDT Payment/);
  assert.match(frontend, /setInterval\(j,1e4\)/);
  assert.doesNotMatch(frontend, /Transaction Hash \(TXID\)/);
});

test("campaign APIs isolate records by Telegram owner", () => {
  assert.match(
    server,
    /if\(a\.valid&&a\.userId\)\{t\.telegramUserId=a\.userId/
  );
  assert.doesNotMatch(server, /x-telegram-user-id/);
  assert.doesNotMatch(
    server,
    /new URLSearchParams\(i\)\.get\("user"\)/
  );
  assert.match(
    server,
    /P\.select\(\)\.from\(pe\)\.where\(K\(pe\.telegramId,r\)\)\.orderBy/
  );
  assert.match(
    server,
    /if\(!n\|\|Number\(n\.telegramId\)!==Number\(r\)\)/
  );
  assert.match(
    server,
    /Hi\.post\("\/campaigns".+if\(!a\)\{e\.status\(401\)/
  );
  assert.match(
    server,
    /if\(!i\.telegramId\|\|Number\(t\.telegramUserId\)!==Number\(i\.telegramId\)\)/
  );
});

test("automatic payment UI contains long values and exposes copy feedback", () => {
  assert.match(frontend, /aria-label":"Copy receiving address"/);
  assert.match(frontend, /children:b\?"Copied":"Copy"/);
  assert.match(frontend, /document\.execCommand\("copy"\)/);
  assert.match(frontend, /payment-address-row/);
  assert.match(frontendCss, /\.payment-address\{[^}]+overflow-wrap:anywhere/);
  assert.match(frontendCss, /\.payment-copy-button\{[^}]+min-width:82px/);
  assert.match(frontendCss, /@media\(max-width:360px\)/);
  assert.doesNotMatch(frontend, /bg-amber-500\/10 border border-amber-500\/20/);
});
