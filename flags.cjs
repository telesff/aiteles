/**
 * TELES ADS — Feature flags (planworkv1 Phase 2, #38)
 * DB-backed, 60s memory cache, defaults-safe (never throws).
 *
 * Flags:
 *   strict_bot_admin  — when ON, channel submissions require bot admin (#9 strict mode)
 *   maintenance_mode  — when ON, non-admin mutations get 503 MAINTENANCE (#263 server side)
 *   signup_enabled    — reserved for future auth gating
 */
"use strict";

const DEFAULTS = {
  strict_bot_admin: false,
  maintenance_mode: false,
  signup_enabled: true,
};

let cache = { ts: 0, flags: { ...DEFAULTS } };
const TTL = 60 * 1000;
let pool = null;
let poolBroken = false;

function getPool() {
  if (pool || poolBroken) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) { poolBroken = true; return null; }
  try {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, ssl: { rejectUnauthorized: false } });
  } catch (e) {
    poolBroken = true;
  }
  return pool;
}

async function getFlags() {
  const now = Date.now();
  if (now - cache.ts < TTL) return cache.flags;
  const p = getPool();
  if (!p) {
    cache = { ts: now, flags: { ...DEFAULTS } };
    return cache.flags;
  }
  try {
    const r = await p.query("SELECT key, enabled FROM flags");
    const flags = { ...DEFAULTS };
    for (const row of r.rows) if (row.key in flags) flags[row.key] = !!row.enabled;
    cache = { ts: now, flags };
  } catch (e) {
    cache = { ts: now, flags: { ...DEFAULTS } };
  }
  return cache.flags;
}

/* sync peek for hot paths — serves cache (or defaults) without awaiting */
function peekFlags() {
  return cache.flags;
}

function invalidate() {
  cache.ts = 0;
}

module.exports = { getFlags, peekFlags, invalidate, DEFAULTS };
