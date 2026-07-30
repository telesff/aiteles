const test = require("node:test");
const assert = require("node:assert/strict");

const { createAiClient, splitList } = require("../teles-ai-client.cjs");

const silentLogger = { warn() {}, error() {} };
const messages = [{ role: "user", content: "hello" }];

function reply(status, text = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (text ? { choices: [{ message: { content: text } }] } : {}),
  };
}

test("parses and deduplicates comma-separated credential pools", () => {
  assert.deepEqual(splitList("one,two", "two\nthree", ""), ["one", "two", "three"]);
});

test("moves to the next OpenRouter key after a key-specific failure", async () => {
  const calls = [];
  const client = createAiClient({
    env: { OPENROUTER_API_KEYS: "or-one,or-two", OPENROUTER_MODELS: "model-a" },
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return calls.length === 1 ? reply(429) : reply(200, "second key worked");
    },
  });
  const result = await client.complete(messages);
  assert.equal(result.text, "second key worked");
  assert.equal(result.provider, "OpenRouter");
  assert.deepEqual(calls.map((call) => call.authorization), ["Bearer or-one", "Bearer or-two"]);
});

test("switches directly to NVIDIA when OpenRouter is unavailable", async () => {
  const calls = [];
  const client = createAiClient({
    env: { OPENROUTER_API_KEYS: "or-one,or-two", NVIDIA_API_KEYS: "nv-one,nv-two" },
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("openrouter.ai") ? reply(503) : reply(200, "NVIDIA worked");
    },
  });
  const result = await client.complete(messages);
  assert.equal(result.text, "NVIDIA worked");
  assert.equal(result.provider, "NVIDIA");
  assert.equal(calls.filter((url) => url.includes("openrouter.ai")).length, 1);
  assert.equal(calls.filter((url) => url.includes("nvidia.com")).length, 1);
});

test("tries every configured credential when failures are key-specific", async () => {
  let attempts = 0;
  const client = createAiClient({
    env: {
      OPENROUTER_API_KEYS: "or1,or2,or3,or4,or5",
      NVIDIA_API_KEYS: "nv1,nv2,nv3",
    },
    logger: silentLogger,
    fetchImpl: async () => {
      attempts += 1;
      return reply(429);
    },
  });
  const result = await client.complete(messages);
  assert.equal(result.ok, false);
  assert.equal(attempts, 8);
  assert.deepEqual(client.credentialCounts, { openRouter: 5, nvidia: 3 });
});

test("rotates the first credential between requests", async () => {
  const authorizations = [];
  const client = createAiClient({
    env: { OPENROUTER_API_KEYS: "or-one,or-two" },
    logger: silentLogger,
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return reply(200, "ok");
    },
  });
  await client.complete(messages);
  await client.complete(messages);
  assert.deepEqual(authorizations, ["Bearer or-one", "Bearer or-two"]);
});
