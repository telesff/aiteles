const test = require("node:test");
const assert = require("node:assert/strict");

const { handleUpdate, parseMemberTarget } = require("../teles-agent.cjs");

test("parses an exact numeric member target", () => {
  assert.equal(parseMemberTarget("5,000"), 5_000);
  assert.equal(parseMemberTarget("12500 Members"), 12_500);
});

test("parses abbreviated and ranged member targets", () => {
  assert.equal(parseMemberTarget("2.5k Members"), 2_500);
  assert.equal(parseMemberTarget("3k–5k Members"), 5_000);
  assert.equal(parseMemberTarget("15,000-25,000"), 25_000);
  assert.equal(parseMemberTarget("1m+"), 1_000_000);
});

test("rejects an invalid target instead of defaulting to 2,000", () => {
  assert.equal(parseMemberTarget(""), null);
  assert.equal(parseMemberTarget("Members included"), null);
  assert.equal(parseMemberTarget(null), null);
});

test("leaves /start routing to the main Telegram bot", async () => {
  assert.equal(
    await handleUpdate({
      text: "/start",
      chatId: 1,
      userId: 2,
      update: { message: { chat: { type: "private" } } },
    }),
    false
  );
  assert.equal(
    await handleUpdate({
      text: "/start@TelesAdsBot ref_123",
      chatId: 1,
      userId: 2,
      update: { message: { chat: { type: "private" } } },
    }),
    false
  );
});
