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

test("private invite links get PRIVATE_LINK code", () => {
  assert.equal(norm("https://t.me/+AbCdEfGhIjKlMn").code, "PRIVATE_LINK");
  assert.equal(norm("t.me/joinchat/AAAAAcCCCC").code, "PRIVATE_LINK");
  assert.equal(norm("telegram.me/joinchat/BBBBB").code, "PRIVATE_LINK");
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
    ["durov", "@durov"],
    ["  @durov  ", "@durov"],
    ["TELESADS", "@telesads"],
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
