/**
 * TELES ADS — Channel input guard (planworkv1 Phase 1, items #1-20)
 *
 * Express middleware mounted globally before the /api router:
 *   rn.use(tk); rn.use(require("./channel-guard.cjs")); rn.use("/api", QI);
 *
 * Pipeline for every channel-link intake (create AND edit):
 *   soft-lock -> rate-limit -> normalize -> format -> resolve (getChat)
 *   -> type check -> bot-admin record -> probe fallback -> audit -> body rewrite
 *
 * Error contract (#23): { error: <human copy>, code: <machine code>, field: <string> }
 * Codes: INVALID_FORMAT | EMPTY_FIELD | PRIVATE_LINK | NOT_FOUND | NOT_CHANNEL |
 *        RATE_LIMITED | SOFT_LOCKED
 */
"use strict";

const https = require("https");

/* ------------------------------------------------------------------ config */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_ID = /^\d+/.test(BOT_TOKEN) ? BOT_TOKEN.split(":")[0] : "";
const RESOLVE_TTL_MS = 10 * 60 * 1000;            /* #11 cache TTL */
const RATE_LIMIT_MAX = 10;                        /* #14 resolves/user/minute */
const RATE_WINDOW_MS = 60 * 1000;
const SOFT_LOCK_MAX = 8;                          /* #20 failures/user/10min */
const SOFT_LOCK_WINDOW_MS = 10 * 60 * 1000;
const TG_TIMEOUT_MS = 6000;

/* Telegram public username: letter first, then 4-31 more [A-Za-z0-9_] (5-32 total) */
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

const MESSAGES = {
  EMPTY_FIELD: "Channel link is required.",
  INVALID_FORMAT:
    "That doesn't look like a channel. Use @username or a t.me/username link.",
  PRIVATE_LINK:
    "Private invite links aren't supported. Use the channel's public @username or t.me/username link.",
  NOT_FOUND:
    "We couldn't find that channel on Telegram. Check the spelling - it must be a public channel.",
  NOT_CHANNEL: "That link points to a user or group, not a channel.",
  RATE_LIMITED: "Too many checks right now. Please wait a moment and try again.",
  SOFT_LOCKED:
    "Too many invalid attempts. Please wait a few minutes before trying again.",
  TG_UNAVAILABLE: "We couldn't verify the channel right now. Please try again.",
};

/* --------------------------------------------------------- pure validators */
function normalizeChannelInput(raw) {
  if (typeof raw !== "string") return { code: "INVALID_FORMAT", value: "" };
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return { code: "EMPTY_FIELD", value: "" };

  /* Reject control chars / markup / quoting outright (#177 XSS+SQLi pack) */
  if (/[\u0000-\u001F\u007F<>"'`\\{}$;]/.test(s)) {
    return { code: "INVALID_FORMAT", value: s };
  }

  /* Private invite links - distinct code (#3) */
  if (
    /t\.me\/\+/i.test(s) ||
    /t\.me\/joinchat\//i.test(s) ||
    /telegram\.me\/joinchat\//i.test(s)
  ) {
    return { code: "PRIVATE_LINK", value: s };
  }

  /* URL forms: (https?://)? (www.)? (t.me|telegram.me) / [s/] username ... */
  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{0,31})(?:[/?#].*)?$/i
  );
  if (urlMatch) return { code: null, value: "@" + urlMatch[1].toLowerCase() };

  /* Bare @username */
  if (s.charAt(0) === "@") {
    const name = s.slice(1);
    if (!USERNAME_RE.test(name)) return { code: "INVALID_FORMAT", value: s };
    return { code: null, value: "@" + name.toLowerCase() };
  }

  /* Bare username (typed without @). "hhjagwv" passes FORMAT here and is
     caught by Telegram resolution below (#7) - format alone cannot know. */
  if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s)) {
    return { code: null, value: "@" + s.toLowerCase() };
  }

  return { code: "INVALID_FORMAT", value: s };
}

function validateFormat(raw) {
  return normalizeChannelInput(raw).code === null;
}

/* --------------------------------------------------------- memory limiter */
const resolveCache = new Map(); /* username -> { ts, entry } */
const rateBuckets = new Map();  /* userId -> [timestamps] */
const failBuckets = new Map();  /* userId -> [timestamps] (#20 soft-lock) */

function prune(arr, windowMs, now) {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr;
}

function rateCheck(userId, now) {
  now = now || Date.now();
  const arr = prune(rateBuckets.get(userId) || [], RATE_WINDOW_MS, now);
  if (arr.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(userId, arr);
    return {
      limited: true,
      retryAfter: Math.ceil((RATE_WINDOW_MS - (now - arr[0])) / 1000),
    };
  }
  arr.push(now);
  rateBuckets.set(userId, arr);
  return { limited: false };
}

function softLockCheck(userId, now) {
  now = now || Date.now();
  const arr = prune(failBuckets.get(userId) || [], SOFT_LOCK_WINDOW_MS, now);
  if (arr.length >= SOFT_LOCK_MAX) {
    failBuckets.set(userId, arr);
    return {
      locked: true,
      retryAfter: Math.ceil((SOFT_LOCK_WINDOW_MS - (now - arr[0])) / 1000),
    };
  }
  return { locked: false };
}

function recordFailure(userId, now) {
  now = now || Date.now();
  const arr = prune(failBuckets.get(userId) || [], SOFT_LOCK_WINDOW_MS, now);
  arr.push(now);
  failBuckets.set(userId, arr);
}

function clearFailures(userId) {
  failBuckets.delete(userId);
}

/* keep memory bounded (unref so tests / idle processes can exit) */
const sweeper = setInterval(function () {
  const now = Date.now();
  for (const [k, v] of resolveCache) if (now - v.ts > RESOLVE_TTL_MS) resolveCache.delete(k);
  for (const [k, v] of rateBuckets) if (!prune(v, RATE_WINDOW_MS, now).length) rateBuckets.delete(k);
  for (const [k, v] of failBuckets) if (!prune(v, SOFT_LOCK_WINDOW_MS, now).length) failBuckets.delete(k);
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

/* ------------------------------------------------------ telegram plumbing */
function tgGet(method, params, timeoutMs) {
  timeoutMs = timeoutMs || TG_TIMEOUT_MS;
  return new Promise(function (resolve) {
    if (!BOT_TOKEN) return resolve({ ok: false, transport: true, error: "no-token" });
    const qs = new URLSearchParams(params).toString();
    const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/" + method + "?" + qs;
    const req = https.get(url, { timeout: timeoutMs }, function (res) {
      let body = "";
      res.on("data", function (c) { body += c; });
      res.on("end", function () {
        try {
          const j = JSON.parse(body);
          if (j.ok) return resolve({ ok: true, result: j.result });
          const desc = String(j.description || "");
          const transport =
            res.statusCode === 429 ||
            res.statusCode >= 500 ||
            /timeout|too many|internal/i.test(desc);
          resolve({ ok: false, transport: transport, error: desc || "tg-error" });
        } catch (e) {
          resolve({ ok: false, transport: true, error: "bad-json" });
        }
      });
    });
    req.on("error", function () { resolve({ ok: false, transport: true, error: "network" }); });
    req.on("timeout", function () {
      req.destroy();
      resolve({ ok: false, transport: true, error: "timeout" });
    });
  });
}

/* NOTE: no t.me HTML probe. Telegram serves a skeleton 200 page for
   NONEXISTENT usernames (false-positive), while getChat already resolves
   public channels the bot is not a member of — so "chat not found" is a
   definitive rejection (this is exactly how hhjagwv used to slip through). */

/**
 * Full resolution for "@username".
 *  ok:true  verified:"telegram" (getChat) | "link_probe" (t.me page) | "unavailable"
 *  ok:false { code } definitive reject (hhjagwv lands here as NOT_FOUND)
 */
async function resolveUsername(username) {
  const name = username.replace(/^@/, "");
  const cached = resolveCache.get(username);
  if (cached && Date.now() - cached.ts < RESOLVE_TTL_MS) return cached.entry;

  let entry;
  const chat = await tgGet("getChat", { chat_id: "@" + name });

  if (chat.ok) {
    const type = chat.result.type;
    if (type !== "channel" && type !== "supergroup") {
      entry = { ok: false, code: "NOT_CHANNEL" };
    } else {
      let botAdmin = null;
      let members = null;
      if (BOT_ID) {
        const member = await tgGet("getChatMember", {
          chat_id: String(chat.result.id),
          user_id: BOT_ID,
        });
        if (member.ok) {
          const st = member.result.status;
          botAdmin = st === "administrator" || st === "creator";
        }
        const count = await tgGet("getChatMemberCount", { chat_id: String(chat.result.id) });
        if (count.ok && typeof count.result === "number") members = count.result;
      }
      entry = {
        ok: true,
        verified: "telegram",
        chatId: chat.result.id,
        type: type,
        title: chat.result.title || null,
        members: members,
        botAdmin: botAdmin, /* #9 recorded (warn, not hard-reject - see plan) */
      };
    }
  } else if (chat.transport) {
    /* Telegram unreachable - fail OPEN (verified:"unavailable") so sales do not
       stall; format-garbage was already rejected before this point. */
    entry = { ok: true, verified: "unavailable", chatId: null, botAdmin: null, members: null, title: null };
  } else {
    /* Definitive "chat not found" (or TG-permission error on a non-public
       entity): reject. Public channels resolve via getChat without membership. */
    entry = { ok: false, code: "NOT_FOUND" };
  }

  resolveCache.set(username, { ts: Date.now(), entry: entry });
  return entry;
}

/* ------------------------------------------------------------- audit (#18) */
let auditPool = null;
let auditBroken = false;

async function auditRejection(info) {
  if (auditBroken) return;
  try {
    if (!auditPool) {
      const url = process.env.DATABASE_URL;
      if (!url) { auditBroken = true; return; }
      const { Pool } = require("pg");
      auditPool = new Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
    }
    await auditPool.query(
      "INSERT INTO validation_audit (route, telegram_id, input_raw, input_norm, code) VALUES ($1, $2, $3, $4, $5)",
      [
        String(info.route || "").slice(0, 120),
        info.userId || null,
        String(info.raw == null ? "" : info.raw).slice(0, 500),
        String(info.normalized || "").slice(0, 500),
        String(info.code || "").slice(0, 40),
      ]
    );
  } catch (e) {
    auditBroken = true; /* audit must never break the request path */
  }
}

/* --------------------------------------------------------------- responder */
function sendError(res, status, code, field, extra) {
  const payload = {
    error: MESSAGES[code] || "Invalid channel input.",
    code: code,
    field: field || "channelLink",
  };
  if (extra) Object.assign(payload, extra);
  res.status(status).json(payload);
}

/* ------------------------------------------------------------- intake table */
function routeSpec(path, method) {
  if (method === "POST" && path === "/api/campaigns")
    return { field: "channelLink", required: true, route: "campaigns" };
  if (method === "PUT" && path === "/api/auth/onboarding")
    return { field: "channelLink", required: false, route: "onboarding" };
  if (method === "POST" && path === "/api/leads/meeting")
    return { field: "channelLink", required: true, route: "leads/meeting" };
  if (method === "POST" && path === "/api/leads/custom-campaign")
    return { field: "channelLink", required: true, route: "leads/custom-campaign" };
  if (method === "POST" && path === "/api/admin/channels")
    return { field: "handle", required: true, formatOnly: true, route: "admin/channels" };
  if (method === "PATCH" && path.startsWith("/api/admin/channels/"))
    return { field: "handle", required: false, formatOnly: true, route: "admin/channels/:id" };
  return null;
}

/* ------------------------------------------------------------ main middleware */
async function channelGuard(req, res, next) {
  try {
    const path = (req.path || "").split("?")[0];
    if (path.indexOf("/api/") !== 0) return next();

    /* ---- POST /api/channels/verify : live check endpoint for the UI (#5/#103) ---- */
    if (req.method === "POST" && path === "/api/channels/verify") {
      const vuserId = req.telegramUserId;
      if (!vuserId) {
        return res
          .status(401)
          .json({ error: "Telegram authentication required.", code: "UNAUTHENTICATED" });
      }
      if (!req.isAdmin) {
        const vlock = softLockCheck(String(vuserId));
        if (vlock.locked) {
          return sendError(res, 429, "SOFT_LOCKED", "link", { retryAfter: vlock.retryAfter });
        }
        const vrl = rateCheck("verify:" + String(vuserId));
        if (vrl.limited) {
          return sendError(res, 429, "RATE_LIMITED", "link", { retryAfter: vrl.retryAfter });
        }
      }
      const vbody = req.body && typeof req.body === "object" ? req.body : {};
      const vraw = vbody.link != null ? vbody.link : vbody.channelLink;
      if (vraw == null || String(vraw).trim() === "") {
        return sendError(res, 400, "EMPTY_FIELD", "link");
      }
      const vnorm = normalizeChannelInput(vraw);
      if (vnorm.code) {
        recordFailure(String(vuserId));
        auditRejection({ route: "verify", userId: vuserId, raw: vraw, normalized: vnorm.value, code: vnorm.code });
        return sendError(res, 400, vnorm.code, "link");
      }
      const vresolved = await resolveUsername(vnorm.value);
      if (!vresolved.ok) {
        recordFailure(String(vuserId));
        auditRejection({ route: "verify", userId: vuserId, raw: vraw, normalized: vnorm.value, code: vresolved.code });
        return sendError(res, 400, vresolved.code, "link");
      }
      clearFailures(String(vuserId));
      return res.json({
        ok: true,
        canonical: vnorm.value,
        verified: vresolved.verified,
        chatId: vresolved.chatId,
        title: vresolved.title || null,
        members: vresolved.members,
        botAdmin: vresolved.botAdmin,
      });
    }

    /* ---- intake routes ---- */
    const spec = routeSpec(path, req.method);
    if (!spec) return next();

    const body = req.body && typeof req.body === "object" ? req.body : null;
    if (!body) return next(); /* let the handler respond its usual way */

    const value = body[spec.field];

    if (value == null || String(value).trim() === "") {
      if (!spec.required) return next();
      return sendError(res, 400, "EMPTY_FIELD", spec.field);
    }

    /* Auth ordering: handlers own the 401 - never leak validation before it. */
    if (!req.telegramUserId) return next();

    const userId = String(req.telegramUserId);

    if (!req.isAdmin) {
      const lock = softLockCheck(userId);
      if (lock.locked) {
        return sendError(res, 429, "SOFT_LOCKED", spec.field, { retryAfter: lock.retryAfter });
      }
    }

    const norm = normalizeChannelInput(value);
    if (norm.code) {
      if (!req.isAdmin) recordFailure(userId);
      auditRejection({ route: spec.route, userId: userId, raw: value, normalized: norm.value, code: norm.code });
      return sendError(res, 400, norm.code, spec.field);
    }

    /* Format-only routes (admin marketplace CRUD): normalize + stop (#19) */
    if (spec.formatOnly) {
      body[spec.field] = norm.value;
      return next();
    }

    if (!req.isAdmin) {
      const rl = rateCheck(userId);
      if (rl.limited) {
        auditRejection({ route: spec.route, userId: userId, raw: value, normalized: norm.value, code: "RATE_LIMITED" });
        return sendError(res, 429, "RATE_LIMITED", spec.field, { retryAfter: rl.retryAfter });
      }
    }

    const resolved = await resolveUsername(norm.value);
    if (!resolved.ok) {
      if (!req.isAdmin) recordFailure(userId);
      auditRejection({ route: spec.route, userId: userId, raw: value, normalized: norm.value, code: resolved.code });
      return sendError(res, 400, resolved.code, spec.field);
    }

    if (!req.isAdmin) clearFailures(userId);

    /* Canonical rewrite: handlers persist/notify the verified form (#2, #12) */
    body[spec.field] = norm.value;
    req.channelValidation = {
      canonical: norm.value,
      verified: resolved.verified,
      chatId: resolved.chatId,
      members: resolved.members,
      botAdmin: resolved.botAdmin,
      title: resolved.title || null,
    };
    return next();
  } catch (err) {
    /* The guard must never take the API down. */
    try { console.error("[channel-guard]", err && err.message); } catch (_) {}
    return next();
  }
}

/* exports - middleware + pure helpers for the test suite */
channelGuard.normalizeChannelInput = normalizeChannelInput;
channelGuard.validateFormat = validateFormat;
channelGuard.USERNAME_RE = USERNAME_RE;
channelGuard.MESSAGES = MESSAGES;
channelGuard.resolveUsername = resolveUsername;
channelGuard._internal = {
  rateCheck: rateCheck,
  softLockCheck: softLockCheck,
  recordFailure: recordFailure,
  clearFailures: clearFailures,
  resolveCache: resolveCache,
};

module.exports = channelGuard;
