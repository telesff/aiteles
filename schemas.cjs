/**
 * TELES ADS — Body schema validation (planworkv1 Phase 2, #21, #22, #23)
 *
 * Zod schemas for EVERY POST/PUT/PATCH route. Unknown keys pass through
 * (passthrough) so hidden client fields keep working; known fields are
 * type/range-checked. Errors use the uniform contract:
 *   { error, code: "VALIDATION_ERROR", field, requestId }
 *
 * Paths are matched after /api/v1 → /api normalization (#24).
 */
"use strict";

const { z } = require("zod");

/* ------------------------------------------------------------- helpers */
const str = (max) => z.string().max(max);
const optStr = (max) => z.string().max(max).optional();
const num = () => z.coerce.number();
const optNum = () => z.coerce.number().optional();
const optBool = () => z.boolean().optional();
const obj = (shape) => z.object(shape).passthrough();

/* ---------------------------------------------------------- route table */
const ROUTES = [
  { m: "POST", re: /^\/api\/campaigns$/, s: obj({
      packageId: z.coerce.number().int().positive(),
      channelLink: str(256),
      audience: z.enum(["forex", "crypto", "binary", "stock"]),
      bannerUrl: optStr(512),
    }) },
  { m: "POST", re: /^\/api\/campaigns\/[^/]+\/payment$/, s: obj({
      txid: optStr(256),
      transactionHash: optStr(256),
      senderAddress: optStr(256),
      walletAddress: optStr(256),
      note: optStr(512),
    }) },
  { m: "PUT", re: /^\/api\/auth\/onboarding$/, s: obj({
      channelLink: z.string().max(256).optional(),
      tradingCategory: optStr(64),
    }) },
  { m: "POST", re: /^\/api\/auth\/login$/, s: obj({
      username: optStr(64),
      firstName: optStr(64),
      lastName: optStr(64),
      photoUrl: optStr(512),
      languageCode: optStr(32),
    }) },
  { m: "POST", re: /^\/api\/support\/tickets$/, s: obj({
      subject: str(200),
      category: str(64),
      orderId: optStr(64),
      description: str(4000),
    }) },
  { m: "POST", re: /^\/api\/feedback$/, s: obj({
      rating: z.coerce.number().int().min(1).max(5),
      comment: str(2000),
    }) },
  { m: "POST", re: /^\/api\/leads\/meeting$/, s: obj({
      fullName: str(120),
      telegramUsername: str(64),
      channelLink: str(256),
      monthlyBudget: z.union([num(), str(64)]).optional(),
      preferredDate: optStr(32),
      preferredTime: optStr(32),
    }) },
  { m: "POST", re: /^\/api\/leads\/custom-campaign$/, s: obj({
      channelLink: str(256),
      currentMembers: num(),
      targetMembers: num(),
      budget: num(),
      targetCountries: optStr(256),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/leads\/[^/]+$/, s: obj({
      status: optStr(32),
      notes: optStr(2000),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/meetings\/[^/]+$/, s: obj({
      status: optStr(32),
      notes: optStr(2000),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/campaigns\/[^/]+$/, s: obj({
      status: optStr(32),
      membersDelivered: optNum(),
      reach: optNum(),
      clicks: optNum(),
      conversionRate: optNum(),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/invoices\/[^/]+$/, s: obj({
      status: optStr(32),
    }) },
  { m: "POST", re: /^\/api\/admin\/channels$/, s: obj({
      name: str(120),
      handle: str(64),
      category: optStr(32),
      members: optNum(),
      engagementRate: optNum(),
      price: optNum(),
      description: optStr(1000),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/channels\/[^/]+$/, s: obj({
      name: optStr(120),
      handle: optStr(64),
      category: optStr(32),
      members: optNum(),
      engagementRate: optNum(),
      price: optNum(),
      description: optStr(1000),
      active: optBool(),
      verified: optBool(),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/tickets\/[^/]+$/, s: obj({ status: optStr(32) }) },
  { m: "POST", re: /^\/api\/admin\/tickets\/[^/]+\/reply$/, s: obj({ message: str(4000) }) },
  { m: "POST", re: /^\/api\/admin\/packages$/, s: obj({
      name: str(120),
      description: optStr(1000),
      members: optStr(64),
      features: z.union([str(4000), z.array(str(200)).max(30)]).optional(),
      price: num(),
      originalPrice: optNum(),
      popular: optBool(),
      active: optBool(),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/packages\/[^/]+$/, s: obj({
      name: optStr(120),
      description: optStr(1000),
      members: optStr(64),
      features: z.union([str(4000), z.array(str(200)).max(30)]).optional(),
      price: num(),
      originalPrice: optNum(),
      popular: optBool(),
      active: optBool(),
    }) },
  { m: "POST", re: /^\/api\/admin\/leaderboard$/, s: obj({
      channelName: str(120),
      handle: str(64),
      growth: num(),
      rank: num(),
      period: optStr(64),
    }) },
  { m: "PATCH", re: /^\/api\/admin\/leaderboard\/[^/]+$/, s: obj({
      channelName: optStr(120),
      handle: optStr(64),
      growth: optNum(),
      rank: optNum(),
      period: optStr(64).optional(),
    }) },
  { m: "POST", re: /^\/api\/agent\/chat$/, s: obj({
      message: z.union([str(4000), z.array(z.any()).max(50)]).optional(),
      conversationId: optStr(128),
    }) },
  { m: "POST", re: /^\/api\/channels\/verify$/, s: obj({
      link: str(256),
      channelLink: optStr(256),
    }) },
];
const TABLE = ROUTES;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * @returns null when route not covered / not an object body issue,
 *          or { field, message } on first schema failure.
 */
function validate(method, path, body) {
  if (!MUTATING.has(method)) return null;
  const row = TABLE.find((r) => r.m === method && r.re.test(path));
  if (!row) return null; // unknown mutation route — still gated by handler checks
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    return { field: "body", message: "Request body must be a JSON object." };
  }
  const res = row.s.safeParse(body);
  if (res.success) return null;
  const issue = res.error.issues[0] || {};
  const field = (issue.path && issue.path.length && String(issue.path.join("."))) || "body";
  const msg = issue.message || "Invalid value.";
  return { field, message: msg };
}

module.exports = { validate, TABLE: TABLE.length };
