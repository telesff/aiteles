"use strict";
/**
 * Test-only Telegram API mock (loaded via `node --require test/mock-tg.cjs server.cjs`).
 * Intercepts BOTH `https.get` (channel-guard tgGet, query-string params) and
 * `fetch` (sendMessage/initData paths, JSON body params). NEVER loaded in prod.
 */
const https = require("https");
const { EventEmitter } = require("events");

function mockResult(method, params) {
  switch (method) {
    case "getChat": {
      const uname = String(params.chat_id || "@x").replace(/^@/, "");
      return { ok: true, result: { id: -1007770001, type: "channel", username: uname, title: "Mock " + uname } };
    }
    case "getChatMemberCount":
      return { ok: true, result: 6871 };
    case "getChatMember":
      return { ok: true, result: { status: "administrator", user: { id: 42, is_bot: true } } };
    case "sendMessage":
    case "setMyCommands":
    case "setWebhook":
    case "deleteWebhook":
      return { ok: true, result: true };
    default:
      return { ok: true, result: true };
  }
}

/* ---- https.get: channel-guard tgGet ---- */
const realGet = https.get;
https.get = function (url) {
  const u = String(url);
  if (u.indexOf("api.telegram.org/bot") !== -1) {
    const m = u.match(/\/bot[^/]+\/([A-Za-z]+)\?/);
    const method = m ? m[1] : "";
    let params = {};
    try { params = Object.fromEntries(new URL(u).searchParams); } catch (_) {}
    const payload = mockResult(method, params);
    const res = new EventEmitter();
    res.statusCode = 200;
    const reqMock = new EventEmitter();
    reqMock.destroy = function () {};
    const cb = arguments[arguments.length - 1];
    process.nextTick(() => {
      if (typeof cb === "function") cb(res);
      process.nextTick(() => {
        res.emit("data", JSON.stringify(payload));
        res.emit("end");
      });
    });
    return reqMock;
  }
  return realGet.apply(this, arguments);
};

/* ---- fetch: Oe sendMessage, bundle API calls ---- */
const realFetch = globalThis.fetch;
globalThis.fetch = async function (url, opts) {
  const u = String(url);
  if (u.indexOf("api.telegram.org/bot") !== -1) {
    const m = u.match(/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)(\?|$)/);
    const method = m ? m[1] : "";
    let params = {};
    try {
      if (opts && opts.body) Object.assign(params, JSON.parse(opts.body));
      if (u.indexOf("?") !== -1) Object.assign(params, Object.fromEntries(new URL(u).searchParams));
    } catch (_) {}
    return new Response(JSON.stringify(mockResult(method, params)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, opts);
};
