"use strict";
/**
 * TELES ADS — Admin user-start notifications (ad-hoc request, 2026-10-01)
 *
 * Every time a user STARTS the agent (bot /start, /agent command) or signs up
 * in the mini app, the admin gets a Telegram message with the user's details.
 *
 * Design:
 *   - reuses the bundle's sendMessage via injected `send(chatId, text, opts)`
 *   - admin targets: ADMIN_TELEGRAM_ID + optional ADMIN_IDS (comma list)
 *   - HTML-escaped details (#53/#54 — user-controlled fields never raw)
 *   - never throws: failures are structured-logged only, start flow unaffected
 *   - 20s per-user dedupe across kinds (stops duplicate delivery races and
 *     bursts; genuinely separate starts >20s apart each notify)
 *   - self-notifications skipped (admin starting the bot = no ping to self)
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function adminIds() {
  const ids = [];
  const push = (v) => {
    for (const part of String(v || "").split(",")) {
      const n = parseInt(part.trim(), 10);
      if (n > 0 && ids.indexOf(n) === -1) ids.push(n);
    }
  };
  push(process.env.ADMIN_TELEGRAM_ID);
  push(process.env.ADMIN_IDS);
  if (!ids.length) ids.push(7049127887); /* bundle fallback — same target as ticket/campaign notifies */
  return ids;
}

const KIND_LABEL = {
  start: "started the bot (/start)",
  agent: "started the AI agent (/agent)",
  signup: "signed up in the mini app",
};

const seen = new Map(); /* uid -> last notify ts (ms) */
const DEDUPE_MS = 20000;

function buildText(kind, from, startParam, row, chatId) {
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ") || "—";
  const username = f.username ? "@" + f.username : "—";
  let platform;
  if (row && row.telegramId) {
    const joined = row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : "—";
    const last = row.lastLoginAt ? new Date(row.lastLoginAt).toISOString().slice(0, 16).replace("T", " ") : "never";
    platform = `existing user (joined ${joined}, last login ${last} UTC)`;
  } else {
    platform = "not registered yet (bot-only visitor)";
  }
  const lines = [
    `🔔 <b>User ${esc(KIND_LABEL[kind] || kind)}</b>`,
    "",
    `<b>Name:</b> ${esc(name)}`,
    `<b>Username:</b> ${esc(username)}`,
    `<b>User ID:</b> ${esc(f.id)}`,
    `<b>Language:</b> ${esc(f.language_code || "—")}`,
    `<b>Premium:</b> ${f.is_premium ? "yes" : "no"}`,
    `<b>Start param:</b> ${esc(startParam || "—")}`,
    `<b>Platform:</b> ${esc(platform)}`,
    `<b>Chat ID:</b> ${esc(chatId != null ? chatId : f.id)}`,
    `<b>When:</b> ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
  ];
  return lines.join("\n");
}

function logLine(level, fields) {
  try {
    console.log(JSON.stringify({ lvl: level, t: new Date().toISOString(), ev: "admin_notify", ...fields }));
  } catch (e) {}
}

/**
 * @param {object} o
 * @param {"start"|"agent"|"signup"} o.kind
 * @param {object} o.from       telegram `from` object (or pseudo-from for signup)
 * @param {string} [o.startParam]
 * @param {*}      [o.dbUser]   promise or array resolving to [userRow] | []
 * @param {Function} o.send     sendMessage(chatId, text, opts) from the bundle
 * @param {*}      [o.chatId]
 * @param {number} [o.now]      injectable clock for tests
 */
async function notifyUserStart(o) {
  try {
    const kind = (o && o.kind) || "start";
    const from = (o && o.from) || {};
    const send = o && o.send;
    if (typeof send !== "function") return { sent: 0, skipped: "no-send" };
    const uid = from.id || (o && o.chatId);
    if (!uid) return { sent: 0, skipped: "no-user" };

    const targets = adminIds();
    if (targets.indexOf(Number(uid)) !== -1) return { sent: 0, skipped: "self" };

    const now = typeof o.now === "number" ? o.now : Date.now();
    const last = seen.get(String(uid)) || 0;
    if (now - last < DEDUPE_MS) return { sent: 0, skipped: "dedupe" };
    seen.set(String(uid), now);
    if (seen.size > 5000) {
      for (const [k, ts] of seen) if (now - ts > DEDUPE_MS * 60) seen.delete(k);
    }

    let row = null;
    try {
      const v = o.dbUser ? await o.dbUser : [];
      row = Array.isArray(v) && v.length ? v[0] : null;
    } catch (e) {
      row = null; /* DB trouble must never block the notify */
    }

    const text = buildText(kind, from, o.startParam, row, o.chatId != null ? o.chatId : uid);
    let sent = 0;
    for (const admin of targets) {
      try {
        await send(admin, text);
        sent++;
      } catch (e) {
        logLine("warn", { kind, uid: String(uid), admin: String(admin), err: String(e && e.message || e).slice(0, 200) });
      }
    }
    logLine("info", { kind, uid: String(uid), sent, targets: targets.length });
    return { sent };
  } catch (e) {
    logLine("error", { err: String(e && e.message || e).slice(0, 200) });
    return { sent: 0, skipped: "error" };
  }
}

module.exports = { notifyUserStart, buildText, adminIds, esc, _seen: seen, DEDUPE_MS };
