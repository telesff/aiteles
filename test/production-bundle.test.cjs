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
