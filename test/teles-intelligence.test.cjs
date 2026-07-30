const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateCampaignHealth,
  estimateCopyBudget,
  extractPublicPostStats,
  fetchChannelIntelligence,
  parseCompactNumber,
  parseTelegramChannel,
} = require("../teles-intelligence.cjs");

test("normalizes public Telegram channel references", () => {
  assert.equal(parseTelegramChannel("https://t.me/TelesAds"), "TelesAds");
  assert.equal(parseTelegramChannel("https://telegram.me/s/TelesAds?before=10"), "TelesAds");
  assert.equal(parseTelegramChannel("@TelesAds"), "TelesAds");
  assert.equal(parseTelegramChannel("https://t.me/+privateInvite"), null);
});

test("parses Telegram compact metrics and public post data", () => {
  assert.equal(parseCompactNumber("12.5K"), 12_500);
  assert.equal(parseCompactNumber("1.2m"), 1_200_000);
  const stats = extractPublicPostStats(`
    <span class="tgme_widget_message_views">1.2K</span>
    <time datetime="2026-07-30T00:00:00+00:00"></time>
    <span class="tgme_widget_message_views">800</span>
  `);
  assert.deepEqual(stats.views, [1_200, 800]);
  assert.equal(stats.dates.length, 1);
});

test("combines Telegram metadata with sampled public post metrics", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/getChatMemberCount")) {
      return { ok: true, json: async () => ({ ok: true, result: 10_000 }) };
    }
    if (url.includes("/getChat")) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { title: "Sample Channel", description: "Public" } }),
      };
    }
    return {
      ok: true,
      text: async () => `
        <span class="tgme_widget_message_views">1K</span>
        <span class="tgme_widget_message_views">2K</span>
        <time datetime="${new Date().toISOString()}"></time>
      `,
    };
  };
  const result = await fetchChannelIntelligence("@SampleChannel", {
    botToken: "test-token",
    fetchImpl,
  });
  assert.equal(result.title, "Sample Channel");
  assert.equal(result.subscriberCount, 10_000);
  assert.equal(result.avgViews, 1_500);
  assert.equal(result.estimatedViewRate, 15);
  assert.equal(result.estimatedCtrProxy, 1.8);
  assert.equal(result.postsLast7d, 1);
});

test("builds a package-based copy budget with the managed minimum", () => {
  const result = estimateCopyBudget(30_000, [
    { members: "5k", price: 500 },
    { members: "10k", price: 800 },
  ]);
  assert.equal(result.suggestedTarget, 3_000);
  assert.equal(result.minimumBudget, 789);
  assert.equal(result.estimatedBudget, 790);
});

test("campaign health uses delivery progress and terminal status", () => {
  const active = calculateCampaignHealth({
    membersTarget: 10_000,
    membersDelivered: 5_000,
    status: "active",
    createdAt: new Date(Date.now() - 2 * 86_400_000),
  });
  assert.equal(active.progress, 50);
  assert.ok(active.score >= 0 && active.score <= 100);
  assert.equal(
    calculateCampaignHealth({ membersTarget: 10, membersDelivered: 10, status: "completed" }).score,
    100
  );
});
