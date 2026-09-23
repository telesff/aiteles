/**
 * TELES ADS — Backend hardening middleware (planworkv1 Phase 2)
 *
 *   early        → request-id, security headers, webhook secret, ip rate-limit,
 *                  body schemas (#21), health (#37), cron (#32/#33), access log (#26)
 *   late         → admin gate defense-in-depth (#40), login rate (#45),
 *                  maintenance flag (#38), bot-command flood control (#46)
 *   errorHandler → uniform500/400, never leaks stacks or DB text (#27)
 *
 * Mounted:
 *   urlencoded → early → tk(auth) → late → channel-guard → /api router → errorHandler
 */
"use strict";

const crypto = require("crypto");
const schemas = require("./schemas.cjs");
const flagsMod = require("./flags.cjs");
const guard = require("./channel-guard.cjs");
const sigEq = guard.sigEq;

/* ------------------------------------------------------------ constants */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  /* CSP = frame-ancestors replaces X-Frame-Options (allows t.me/web.telegram.org frames, blocks others) */
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-src 'self' https://telegram.org https://web.telegram.org https://*.t.me",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.t.me",
  ].join("; "),
};
if (process.env.NODE_ENV !== "production") {
  /* HSTS only meaningful over TLS; harmless elsewhere */
}
SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";

const IP_LIMIT = 180;         /* #45 generic API flood, per IP per minute */
const WEBHOOK_USER_LIMIT = 40; /* #46 bot messages per user per minute */
const LOGIN_LIMIT = 10;       /* #45 auth endpoint per user per minute */

/* --------------------------------------------------------------- buckets */
const ipBuckets = new Map();
const whBuckets = new Map();
const loginBuckets = new Map();

function prune(arr, windowMs, now) {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr;
}
function hit(bucket, key, limit, windowMs) {
  const now = Date.now();
  const arr = prune(bucket.get(key) || [], windowMs, now);
  if (arr.length >= limit) {
    bucket.set(key, arr);
    return { limited: true, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  bucket.set(key, arr);
  return { limited: false };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets) if (!prune(v, 60000, now).length) ipBuckets.delete(k);
  for (const [k, v] of whBuckets) if (!prune(v, 60000, now).length) whBuckets.delete(k);
  for (const [k, v] of loginBuckets) if (!prune(v, 60000, now).length) loginBuckets.delete(k);
}, 60000).unref && undefined;
/* unref guard: setInterval(...).unref may not exist in some hosts */
try { /* already called above via expression; ensure unref */ } catch (e) {}

/* ------------------------------------------------------------- utilities */
function normalizeApiPath(p) {
  if (p === "/api/v1") return "/api";
  if (p.indexOf("/api/v1/") === 0) return "/api" + p.slice(7);
  return p;
}

function sendErr(res, status, code, message, field, requestId) {
  res.status(status).json({
    error: message,
    code,
    ...(field ? { field } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function logLine(level, fields) {
  try {
    console.log(JSON.stringify({ lvl: level, t: new Date().toISOString(), ...fields }));
  } catch (e) {}
}

/* --------------------------------------------------------- shared DB pool */
let dbPool = null;
let dbBroken = false;
function getPool() {
  if (dbPool || dbBroken) return dbPool;
  const url = process.env.DATABASE_URL;
  if (!url) { dbBroken = true; return null; }
  try {
    const { Pool } = require("pg");
    dbPool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 3000, ssl: { rejectUnauthorized: false } });
  } catch (e) { dbBroken = true; }
  return dbPool;
}

/* ------------------------------------------------------------ health (#37) */
async function handleHealth(req, res) {
  const started = Date.now();
  const p = getPool();
  let dbOk = false;
  let dbMs = null;
  if (p) {
    try {
      const t0 = Date.now();
      await p.query("SELECT 1");
      dbOk = true;
      dbMs = Date.now() - t0;
    } catch (e) { dbOk = false; }
  }
  const payload = {
    status: dbOk ? "ok" : "degraded",
    db: { ok: dbOk, ms: dbMs },
    time: new Date().toISOString(),
    requestId: req.id,
    uptimeSec: Math.round(process.uptime()),
  };
  res.status(dbOk ? 200 : 503).json(payload);
}

/* ------------------------------------------------------------ cron (#32/#33) */
async function handleCron(req, res) {
  const authz = String(req.headers.authorization || "");
  const provided = authz.replace(/^Bearer\s+/i, "");
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !sigEq(provided.padEnd(64).slice(0, 64), expected.padEnd(64).slice(0, 64)) || provided !== expected) {
    /* strict compare too (sigEq needs equal len; direct fallback) */
    if (provided !== expected || !expected) {
      return sendErr(res, 403, "CRON_SECRET", "Forbidden.", null, req.id);
    }
  }
  const t0 = Date.now();
  const results = {};
  const errors = [];
  const p = getPool();

  /* invoice expiry sweep — pending > 24h → expired */
  if (p) {
    try {
      const r = await p.query(
        "UPDATE invoices SET status='expired' WHERE status='pending' AND created_at < NOW() - INTERVAL '24 hours'"
      );
      results.expiredInvoices = r.rowCount || 0;
    } catch (e) { errors.push("invoice_expiry: " + e.message); }

    /* drain due jobs (#32 — Vercel-safe queue: DB rows + this runner) */
    try {
      const due = await p.query(
        "SELECT * FROM jobs WHERE status='pending' AND run_at <= NOW() ORDER BY run_at LIMIT 10"
      );
      let run = 0;
      for (const job of due.rows) {
        try {
          if (job.type === "reverify_channel" && job.payload && job.payload.handle) {
            await guard.resolveUsername(String(job.payload.handle));
          }
          /* future job types extend here */
          await p.query("UPDATE jobs SET status='done' WHERE id=$1", [job.id]);
          run++;
        } catch (e) {
          const attempts = (job.attempts || 0) + 1;
          await p.query(
            "UPDATE jobs SET status=$1, attempts=$2, last_error=$3 WHERE id=$4",
            [attempts >= 3 ? "failed" : "pending", attempts, String(e.message).slice(0, 500), job.id]
          ).catch(() => {});
          errors.push(job.type + ": " + e.message);
        }
      }
      results.jobsRun = run;
    } catch (e) { errors.push("jobs: " + e.message); }

    /* heartbeat for ops dashboards */
    try {
      await p.query(
        `INSERT INTO cron_state (key, last_run_at, last_duration_ms, last_result)
         VALUES ('main', NOW(), $1, $2)
         ON CONFLICT (key) DO UPDATE SET last_run_at = NOW(), last_duration_ms = $1, last_result = $2, updated_at = NOW()`,
        [Date.now() - t0, JSON.stringify({ results, errors: errors.slice(0, 5) }).slice(0, 900)]
      );
    } catch (e) { errors.push("heartbeat: " + e.message); }
  } else {
    errors.push("no-database");
  }

  logLine("info", { ev: "cron", tookMs: Date.now() - t0, results, errors: errors.length });
  res.status(200).json({ ok: true, degraded: errors.length > 0, results, errors, tookMs: Date.now() - t0 });
}

/* Enqueue helper for future phases (#32) */
async function enqueue(type, payload, runAt) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "INSERT INTO jobs (type, payload, run_at) VALUES ($1, $2, COALESCE($3, NOW())) RETURNING id",
    [type, JSON.stringify(payload || {}), runAt || null]
  );
  return r.rows[0].id;
}

/* ------------------------------------------------------------------ EARLY */
async function early(req, res, next) {
  try {
    /* #25 request id */
    const inbound = req.headers["x-request-id"];
    req.id =
      typeof inbound === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(inbound)
        ? inbound
        : crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    res.removeHeader("X-Powered-By");

    /* #48/#49 security headers */
    for (const k of Object.keys(SECURITY_HEADERS)) res.setHeader(k, SECURITY_HEADERS[k]);

    /* #47 CORS: neutralize the bundled cors() '*' default — allowlist only.
       Allowed origins get echoed + Vary; everything else gets NO ACAO
       (same-origin requests never need it and are unaffected). */
    const originHdr = req.headers.origin;
    if (originHdr) {
      const allowed =
        originHdr === "https://aiteles-gamma.vercel.app" ||
        originHdr === "https://web.telegram.org" ||
        originHdr === "https://t.me" ||
        originHdr === "https://www.t.me" ||
        originHdr === "https://telegram.org";
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", originHdr);
        res.setHeader("Vary", "Origin");
      } else {
        res.removeHeader("Access-Control-Allow-Origin");
      }
    }

    const rawPath = (req.path || "").split("?")[0];
    const path = normalizeApiPath(rawPath);
    req.normPath = path;

    /* webhook: #30 secret then #46 flood control */
    if (path === "/api/telegram/webhook") {
      const provided = req.headers["x-telegram-bot-api-secret-token"];
      const expected = process.env.WEBHOOK_SECRET || "";
      if (!expected || provided !== expected || !sigEq(String(provided || "").padEnd(64).slice(0, 64), expected.padEnd(64).slice(0, 64))) {
        if (provided !== expected) {
          logLine("warn", { ev: "webhook_reject", requestId: req.id, ip: req.ip });
          return sendErr(res, 403, "WEBHOOK_SECRET", "Forbidden.", null, req.id);
        }
      }
      const from =
        (req.body && req.body.message && req.body.message.from && req.body.message.from.id) ||
        (req.body && req.body.callback_query && req.body.callback_query.from && req.body.callback_query.from.id) ||
        null;
      if (from) {
        const rl = hit(whBuckets, String(from), WEBHOOK_USER_LIMIT, 60000);
        if (rl.limited) {
          /* answer 200 so Telegram does not retry-storm us */
          return res.status(200).json({ ok: true, dropped: true });
        }
      }
      res.on("finish", () =>
        logLine("info", {
          ev: "req", requestId: req.id, method: req.method, path: rawPath,
          status: res.statusCode, ms: Date.now() - req._t0,
        })
      );
      req._t0 = Date.now();
      return next();
    }

    /* health is public + exempt from rate limits (#37) */
    if (req.method === "GET" && path === "/api/health") return handleHealth(req, res);

    /* cron: bearer CRON_SECRET (#33) */
    if (path === "/api/internal/cron") return handleCron(req, res);

    /* #26 access log for API traffic only */
    if (path.indexOf("/api/") === 0) {
      req._t0 = Date.now();
      res.on("finish", () =>
        logLine("info", {
          ev: "req", requestId: req.id, method: req.method, path: rawPath,
          status: res.statusCode, ms: Date.now() - req._t0,
          uid: req.telegramUserId || null,
        })
      );

      /* #45 per-IP flood control */
      const rl = hit(ipBuckets, String(req.ip || "unknown"), IP_LIMIT, 60000);
      if (rl.limited) {
        return sendErr(res, 429, "RATE_LIMITED", "Too many requests. Slow down.", null, req.id);
      }

      /* #21 body schema validation for every mutation */
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
        const bad = schemas.validate(req.method, path, req.body);
        if (bad) {
          return sendErr(res, 400, "VALIDATION_ERROR", bad.message, bad.field, req.id);
        }
      }
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/* ------------------------------------------------------------------ LATE */
async function late(req, res, next) {
  try {
    const path = req.normPath || normalizeApiPath((req.path || "").split("?")[0]);

    /* #40 admin group — explicit gate (defense-in-depth over router _a) */
    if (path.indexOf("/api/admin") === 0) {
      if (!req.telegramUserId) {
        return sendErr(res, 401, "UNAUTHENTICATED", "Telegram authentication required.", null, req.id);
      }
      if (!req.isAdmin) {
        return sendErr(res, 403, "FORBIDDEN", "Access denied. Admin privileges required.", null, req.id);
      }
    }

    /* #45 login rate limit */
    if (req.method === "POST" && path === "/api/auth/login" && req.telegramUserId) {
      const rl = hit(loginBuckets, "login:" + String(req.telegramUserId) + ":" + String(req.ip), LOGIN_LIMIT, 60000);
      if (rl.limited) {
        return sendErr(res, 429, "RATE_LIMITED", "Too many login attempts. Try again shortly.", null, req.id);
      }
    }

    /* #38 flags → attach + maintenance enforcement (#263 server side) */
    const flags = await flagsMod.getFlags();
    req.flags = flags;
    if (
      flags.maintenance_mode &&
      !req.isAdmin &&
      path.indexOf("/api/") === 0 &&
      req.method !== "GET" &&
      path !== "/api/channels/verify"
    ) {
      return sendErr(res, 503, "MAINTENANCE", "We're under maintenance. Please try again soon.", null, req.id);
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/* ---------------------------------------------------------- ERROR HANDLER */
function errorHandler(err, req, res, next) {
  const rid = (req && req.id) || "-";
  if (res.headersSent) return next(err);
  /* body-parser JSON syntax */
  if (err && err.type === "entity.parse.failed") {
    logLine("warn", { ev: "bad_json", requestId: rid, path: req.path });
    return res.status(400).json({
      error: "Request body must be valid JSON.",
      code: "BAD_JSON",
      requestId: rid,
    });
  }
  logLine("error", {
    ev: "unhandled",
    requestId: rid,
    method: req.method,
    path: req.path,
    msg: String((err && err.message) || err).slice(0, 300),
    stack: String((err && err.stack) || "").split("\n").slice(0, 3).join(" | ").slice(0, 400),
  });
  return res.status(500).json({
    error: "Something went wrong. Please try again.",
    code: "INTERNAL",
    requestId: rid,
  });
}

module.exports = { early, late, errorHandler, enqueue, normalizeApiPath };
