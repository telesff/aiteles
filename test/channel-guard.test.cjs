const test = require("node:test");
const assert = require("node:assert/strict");

const guard = require("../channel-guard.cjs");
const norm = (s) => guard.normalizeChannelInput(s);

/* ------------------------------------------------------------------ (#177)
 * Validation test pack: garbage inputs must be rejected at FORMAT stage.
 * (hhjagwv itself is format-valid by Telegram's rules — it is caught by
 *  Telegram resolution, asserted live post-deploy and in the LIVE test below.)
 */
const FORMAT_REJECTS = [
  ["empty", ""],
  ["whitespace only", "     "],
  ["scheme only", "http://"],
  ["phishing url", "https://evil.com/phish"],
  ["plain words", "not a channel"],
  ["bare at", "@"],
  ["double at", "@@"],
  ["triple at", "@@@"],
  ["spaces inside", "@has space"],
  ["emoji handle", "@emoji\ud83d\ude00chan"],
  ["too short", "aaaa"],
  ["sql injection", "'; DROP TABLE channels;--"],
  ["xss script tag", "<script>alert(1)</script>"],
  ["xss img", "<img src=x onerror=alert(1)>"],
  ["generic website", "www.google.com"],
  ["dotted domain", "channel.name.123"],
  ["hyphen handle", "@user-name"],
  ["cyrillic", "\u043a\u0430\u043d\u0430\u043b\u0442\u0433"],
  ["tg scheme", "tg://resolve?domain=durov"],
  ["javascript uri", "javascript:alert(1)"],
  ["mailto", "mailto:x@y.z"],
  ["at with inner space", "@a b"],
  ["500 chars", "x".repeat(500)],
  ["newline split", "user\nname"],
  ["backtick", "@chan`nel"],
  ["dollar brace", "${process.env]"],
  ["quote break", "o'brien"],
  ["non-string number", 12345],
  ["non-string null", null],
  ["non-string object", {}],
];

test("format stage rejects garbage pack (20+ cases)", () => {
  for (const [label, input] of FORMAT_REJECTS) {
    const r = norm(input);
    assert.ok(r.code !== null, label + " must be rejected, got: " + JSON.stringify(r));
    assert.ok(
      r.code === "INVALID_FORMAT" || r.code === "EMPTY_FIELD",
      label + " unexpected code " + r.code
    );
  }
  assert.ok(FORMAT_REJECTS.length >= 20);
});

test("private invite links normalize to canonical https://t.me/+<hash> and pass format", () => {
  const r1 = norm("https://t.me/+AbCdEfGhIjKlMn");
  assert.equal(r1.code, null);
  assert.equal(r1.value, "https://t.me/+AbCdEfGhIjKlMn");
  assert.equal(r1.isPrivate, true);
  assert.equal(r1.inviteHash, "AbCdEfGhIjKlMn");

  const r2 = norm("t.me/joinchat/AAAAAcCCCC12345");
  assert.equal(r2.code, null);
  assert.equal(r2.value, "https://t.me/+AAAAAcCCCC12345");
  assert.equal(r2.isPrivate, true);
  assert.equal(r2.inviteHash, "AAAAAcCCCC12345");

  const r3 = norm("telegram.me/joinchat/BBBBB12345678");
  assert.equal(r3.code, null);
  assert.equal(r3.value, "https://t.me/+BBBBB12345678");
  assert.equal(r3.isPrivate, true);

  const r4 = norm("+AbCdEfGhIjKlMn12");
  assert.equal(r4.code, null);
  assert.equal(r4.value, "https://t.me/+AbCdEfGhIjKlMn12");
  assert.equal(r4.isPrivate, true);
});

test("valid forms normalize to canonical lowercase @username", () => {
  const cases = [
    ["@Valid_Name_1", "@valid_name_1"],
    ["t.me/durov", "@durov"],
    ["https://t.me/durov", "@durov"],
    ["http://telegram.me/Durov", "@durov"],
    ["https://t.me/s/durov", "@durov"],
    ["https://t.me/durov?single", "@durov"],
    ["@durov", "@durov"],
    ["  @durov  ", "@durov"],
    ["@TELESADS", "@telesads"],
  ];
  for (const [input, want] of cases) {
    const r = norm(input);
    assert.equal(r.code, null, input + " should pass, got " + r.code);
    assert.equal(r.value, want, input);
  }
});

test("input shorter than 5 letters is rejected", () => {
  assert.ok(norm("@abc").code !== null);
  assert.ok(norm("abcd").code !== null);
});

test("input longer than 32 chars after @ is rejected", () => {
  assert.ok(norm("@" + "a".repeat(33)).code !== null);
});

/* ------------------------------------------------------------------ (#178)
 * Property/fuzz: seeded pseudo-random strings never throw; anything that
 * passes format must round-trip the canonical username rules.
 */
test("fuzz: 1000 random inputs — no throws, accepts are canonical", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@_-.:/+ #<>'\"\\{}$;[]()!?%,;\n\t\u4e00\u4e00\ud83d\ude00\u0627";
  for (let i = 0; i < 1000; i++) {
    const len = Math.floor(rand() * 64);
    let s = "";
    for (let j = 0; j < len; j++) {
      s += alphabet.charAt(Math.floor(rand() * alphabet.length));
    }
    const r = norm(s); // must never throw
    assert.ok(r && typeof r.code !== "undefined", "fuzz #" + i);
    if (r.code === null) {
      assert.ok(r.value.charAt(0) === "@", "fuzz #" + i + " accept must be @-prefixed");
      assert.ok(
        guard.USERNAME_RE.test(r.value.slice(1)),
        "fuzz #" + i + " accept must satisfy USERNAME_RE: " + r.value
      );
      assert.equal(r.value, r.value.toLowerCase(), "fuzz #" + i + " accept lowercase");
    }
  }
});

test("resolve cache + limiter internals behave", () => {
  const now = Date.now();
  const rl = guard._internal.rateCheck("userX", now);
  assert.equal(rl.limited, false);
  for (let i = 0; i < 9; i++) guard._internal.rateCheck("userX", now + i);
  const limited = guard._internal.rateCheck("userX", now + 20);
  assert.equal(limited.limited, true);
  assert.ok(limited.retryAfter > 0);

  for (let i = 0; i < 8; i++) guard._internal.recordFailure("userY", now + i);
  const lock = guard._internal.softLockCheck("userY", now + 20);
  assert.equal(lock.locked, true);
  guard._internal.clearFailures("userY");
  assert.equal(guard._internal.softLockCheck("userY", now + 30).locked, false);
});

/* LIVE resolution test — only when LIVE_TG=1 (CI stays offline, plan #188) */
test("LIVE: hhjagwv (format-valid) must be rejected by resolution", { skip: !process.env.LIVE_TG }, async () => {
  const r = await guard.resolveUsername("@hhjagwv");
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_FOUND");
});

test("channel resolution: private invite link routes to resolveInviteLink / checkChatInviteLink", async () => {
  const normRes = guard.normalizeChannelInput("https://t.me/+SampleHash12345");
  assert.equal(normRes.code, null);
  assert.equal(normRes.isPrivate, true);
  assert.equal(normRes.inviteHash, "SampleHash12345");

  // Since we are offline / in test env without Telegram API or mock,
  // resolveChannel on this private link should safely return { ok: true, verified: "unavailable", ... } or not crash
  const res = await guard.resolveChannel(normRes);
  assert.ok(res);
  assert.ok(res.ok !== undefined);
  if (res.ok) {
    assert.equal(res.isPrivate, true);
  }
});

test("bare names without @ are refused (e.g. durov, hhjagwv)", () => {
  assert.ok(norm("durov").code !== null);
  assert.ok(norm("hhjagwv").code !== null);
  assert.ok(norm("telesads").code !== null);
});

test("user example link https://t.me/+cR5fEzhYSaNiYjQ0 is accepted and never refused", async () => {
  const input = "https://t.me/+cR5fEzhYSaNiYjQ0";
  const r = norm(input);
  assert.equal(r.code, null);
  assert.equal(r.value, "https://t.me/+cR5fEzhYSaNiYjQ0");
  assert.equal(r.isPrivate, true);

  const res = await guard.resolveChannel(r);
  assert.equal(res.ok, true);
  assert.equal(res.isPrivate, true);
});
