/**
 * TELES ADS — Channel input validation UX (planworkv1 Phase 1, #101-#110)
 *
 * Loaded from index.html (defer) — same zero-rebuild pattern as teles-enhancements.js.
 * Skills applied: vercel web-design-guidelines (aria-live, role=status, focus-visible,
 * prefers-reduced-motion, no transition:all) + emilkowalski mobile-native (no
 * hover-only states, tap feedback, capability queries).
 * Brand palette only: #3b5bff / #1e88ff + semantic green/red/grey status colors.
 *
 * 101 placeholder-style helper · 102 live rule message · 103 grey/green/red states
 * 104 "we verify before saving" · 105 input preserved on failure · 106 code->copy
 * 107 focus first invalid · 108 buttons disable only in flight · 109 button spinner
 * 110 toast system
 */
(function () {
  "use strict";

  if (window.__tvValidation) return;
  window.__tvValidation = true;

  var BRAND = "#3b5bff";
  var OK = "#16a34a";
  var ERR = "#dc2626";
  var GREY = "#6b7280";

  var PLACEHOLDERS = {
    "@handle or t.me/ link": 1,
    "@handle": 1,
    "@yourusername": 1,
    "https://t.me/yourchannel": 1,
    "t.me/yourchannel": 1,
  };

  var INTAKE_RE = /\/api\/(campaigns|leads\/meeting|leads\/custom-campaign|auth\/onboarding)\/?(\?.*)?$/;

  /* ------------------------------------------------------------- styles */
  var style = document.createElement("style");
  style.id = "tv-validation-style";
  style.textContent = [
    ".tv-helper{display:block;margin-top:6px;font-size:12px;line-height:1.35;color:" + GREY + ";}",
    ".tv-status{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;line-height:1.35;color:" + GREY + ";}",
    ".tv-status.tv-ok{color:" + GREY + ";}",
    ".tv-status.tv-verified{color:" + OK + ";font-weight:600;}",
    ".tv-status.tv-error{color:" + ERR + ";font-weight:500;}",
    ".tv-dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.7;flex:0 0 auto;}",
    ".tv-check{font-weight:700;}",
    ".tv-btn-loading{position:relative !important;pointer-events:none;opacity:.75;}",
    ".tv-btn-spinner{display:inline-block;width:13px;height:13px;margin-left:8px;vertical-align:-2px;",
    "border:2px solid currentColor;border-top-color:transparent;border-radius:50%;",
    "animation:tv-spin .7s linear infinite;}",
    "@keyframes tv-spin{to{transform:rotate(360deg)}}",
    "#tv-toasts{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));",
    "transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;",
    "align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:360px;}",
    ".tv-toast{background:#fff;color:#111827;border-radius:10px;padding:10px 14px;font-size:13px;",
    "line-height:1.4;box-shadow:0 6px 24px rgba(15,23,42,.16),0 1px 3px rgba(15,23,42,.08);",
    "display:flex;gap:9px;align-items:flex-start;max-width:100%;",
    "border-left:3px solid " + BRAND + ";animation:tv-toast-in .18s ease-out;}",
    ".tv-toast.tv-toast-error{border-left-color:" + ERR + ";}",
    ".tv-toast.tv-toast-ok{border-left-color:" + OK + ";}",
    ".tv-toast-ico{flex:0 0 auto;font-weight:700;font-size:13px;line-height:1.4;}",
    ".tv-focus:focus-visible{outline:2px solid " + BRAND + ";outline-offset:2px;}",
    "@media (prefers-reduced-motion: reduce){",
    "  .tv-btn-spinner,.tv-toast{animation:none !important;}",
    "}",
  ].join("\n");
  document.head.appendChild(style);

  /* ------------------------------------------------------------- helpers */
  function tgInitData() {
    try {
      return (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
    } catch (e) { return ""; }
  }

  function parsePrivateInvite(raw) {
    if (typeof raw !== "string") return null;
    var s = raw.trim();
    var m1 = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/\+([A-Za-z0-9_-]{6,64})(?:[/?#].*)?$/i);
    if (m1) return { hash: m1[1], canonical: "https://t.me/+" + m1[1] };
    var m2 = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/joinchat\/([A-Za-z0-9_-]{6,64})(?:[/?#].*)?$/i);
    if (m2) return { hash: m2[1], canonical: "https://t.me/+" + m2[1] };
    var m3 = s.match(/^\+([A-Za-z0-9_-]{6,64})$/);
    if (m3) return { hash: m3[1], canonical: "https://t.me/+" + m3[1] };
    return null;
  }

  function normalize(v) {
    if (typeof v !== "string") return { code: "INVALID_FORMAT", value: "" };
    var s = v.trim().replace(/\s+/g, " ");
    if (!s) return { code: "EMPTY_FIELD", value: "" };
    if (/[\u0000-\u001F\u007F<>"'`\\{}$;]/.test(s)) return { code: "INVALID_FORMAT", value: s };

    /* 1. Any t.me/ or telegram.me/ link -> ALWAYS ACCEPT */
    var tmeMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([^\s]+)$/i);
    if (tmeMatch) {
      var path = tmeMatch[1].replace(/\/+$/, "");
      if (!path) return { code: "INVALID_FORMAT", value: s };
      var priv = parsePrivateInvite(s);
      if (priv) return { code: null, value: priv.canonical, isPrivate: true };
      var clean = path.split("?")[0].split("#")[0].replace(/^s\//i, "");
      if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(clean)) {
        return { code: null, value: "@" + clean.toLowerCase(), isPrivate: false };
      }
      return { code: null, value: "https://t.me/" + path, isPrivate: true };
    }

    /* 2. Bare +hash invite link -> accept */
    var privBare = parsePrivateInvite(s);
    if (privBare) return { code: null, value: privBare.canonical, isPrivate: true };

    /* 3. Handle with @ -> accept */
    if (s.charAt(0) === "@") {
      var name = s.slice(1);
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) return { code: "INVALID_FORMAT", value: s };
      return { code: null, value: "@" + name.toLowerCase(), isPrivate: false };
    }

    /* 4. Anything without @ -> REFUSE */
    return { code: "INVALID_FORMAT", value: s };
  }

  /* Server error copy by code (#106) — server remains source of truth */
  var COPY = {
    EMPTY_FIELD: "Channel link is required.",
    INVALID_FORMAT: "Please enter a valid Telegram link (https://t.me/...) or channel username with @ (@channel).",
    PRIVATE_LINK: "Private link received.",
    NOT_FOUND: "We couldn't find that public channel on Telegram. Check the spelling.",
    NOT_CHANNEL: "That link points to a user or group, not a channel.",
    RATE_LIMITED: "Too many checks right now. Wait a moment and try again.",
    SOFT_LOCKED: "Too many invalid attempts. Please wait a few minutes.",
  };

  function copyFor(code, fallback) {
    return COPY[code] || fallback || "Something went wrong. Please try again.";
  }

  /* ------------------------------------------------------------- toasts (#110) */
  var toastRoot = null;
  function toast(msg, kind) {
    if (!toastRoot) {
      toastRoot = document.createElement("div");
      toastRoot.id = "tv-toasts";
      toastRoot.setAttribute("role", "status");
      toastRoot.setAttribute("aria-live", "polite");
      document.body.appendChild(toastRoot);
    }
    var el = document.createElement("div");
    el.className = "tv-toast" + (kind === "error" ? " tv-toast-error" : kind === "ok" ? " tv-toast-ok" : "");
    var ico = document.createElement("span");
    ico.className = "tv-toast-ico";
    ico.textContent = kind === "error" ? "!" : kind === "ok" ? "OK" : "i";
    ico.style.color = kind === "error" ? ERR : kind === "ok" ? OK : BRAND;
    var txt = document.createElement("span");
    txt.textContent = String(msg || "");
    el.appendChild(ico);
    el.appendChild(txt);
    toastRoot.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4200);
  }

  /* ------------------------------------------------------ channel input enhancer */
  var enhanced = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  var uid = 0;
  var verifyTimers = new WeakMap ? new WeakMap() : null;
  var inflight = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var lastState = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pickInput(preferEl) {
    var all = document.querySelectorAll("input.tv-enhanced");
    var i;
    if (preferEl) {
      var form = preferEl.closest ? preferEl.closest("form, section, div") : null;
      if (form && form.querySelector) {
        var inner = form.querySelector("input.tv-enhanced");
        if (inner && isVisible(inner)) return inner;
      }
    }
    for (i = 0; i < all.length; i++) if (isVisible(all[i])) return all[i];
    return all.length ? all[0] : null;
  }

  function setState(input, state, text) {
    if (!input || !input.__tv) return;
    var st = input.__tv.status;
    st.className = "tv-status tv-" + state;
    st.textContent = "";
    var mark = document.createElement("span");
    mark.className = state === "error" ? "tv-dot" : "tv-check";
    if (state === "error") mark.setAttribute("aria-hidden", "true");
    mark.textContent = state === "verified" ? "\u2713" : state === "ok" ? "\u25CB" : state === "error" ? "\u2715" : "";
    if (state === "idle") mark.textContent = "";
    var label = document.createElement("span");
    label.textContent = text || "";
    st.appendChild(mark);
    st.appendChild(label);
    if (state === "error") st.setAttribute("role", "alert");
    else st.setAttribute("role", "status");
    try { lastState.set(input, { state: state, text: text || "" }); } catch (e) {}
  }

  function enhance(input) {
    if (!input || enhanced && enhanced.has(input)) return;
    var id = "tv-in-" + ++uid;

    /* helper (#101, #104) */
    var helper = document.createElement("p");
    helper.className = "tv-helper";
    helper.id = id + "-help";
    helper.textContent = "Paste any Telegram link (https://t.me/...) or channel handle (@channel).";

    /* status (#102, #103) */
    var status = document.createElement("div");
    status.className = "tv-status";
    status.id = id + "-status";
    status.setAttribute("aria-live", "polite");

    input.parentNode.insertBefore(helper, input.nextSibling);
    input.parentNode.insertBefore(status, helper.nextSibling);
    input.setAttribute("aria-describedby", helper.id + " " + status.id);
    input.classList.add("tv-enhanced", "tv-focus");

    input.__tv = { helper: helper, status: status };

    if (enhanced) enhanced.add(input);

    /* char-level rule feedback while typing (#5 debounce, #102) */
    var t = null;
    input.addEventListener("input", function () {
      /* strip disallowed characters as typed (#4 input mask, native-setter safe) */
      var raw = input.value;
      var cleaned = raw.replace(/[^A-Za-z0-9@_\-\.\/:\+ ]/g, "");
      if (cleaned !== raw) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (setter && setter.set) setter.set.call(input, cleaned);
        else input.value = cleaned;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        /* guard against loops: cleaned value no longer matches bad chars */
      }

      if (t) clearTimeout(t);
      var val = input.value;
      if (!val.trim()) {
        setState(input, "idle", "");
        if (input.__tv.abort) { try { input.__tv.abort.abort(); } catch (e) {} }
        return;
      }
      t = setTimeout(function () { localCheck(input); }, 550);
    });

    localCheck(input);
  }

  function localCheck(input) {
    var val = input.value;
    if (!val.trim()) { setState(input, "idle", ""); return; }
    var n = normalize(val);
    if (n.code) {
      setState(input, "error", copyFor(n.code));
      return;
    }
    if (n.value !== val) {
      /* show canonical quietly while keeping user text intact until submit */
    }
    setState(input, "ok", "Format OK — verifying\u2026");
    scheduleVerify(input, n.value);
  }

  function scheduleVerify(input, canonical) {
    if (input.__tv.timer) clearTimeout(input.__tv.timer);
    if (input.__tv.abort) { try { input.__tv.abort.abort(); } catch (e) {} }
    var initData = tgInitData();
    if (!initData) {
      setState(input, "ok", "Format OK — we'll verify on submit");
      return;
    }
    input.__tv.timer = setTimeout(function () {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (ctrl) input.__tv.abort = ctrl;
      fetch("/api/channels/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ link: canonical }),
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(function (res) {
          return res.json().then(function (j) { return { status: res.status, body: j }; });
        })
        .then(function (r) {
          if (input.value === "" ) return;
          if (r.status === 200 && r.body && r.body.ok) {
            var extra = r.body.members != null ? " \u00B7 " + Number(r.body.members).toLocaleString() + " members" : "";
            setState(input, "verified", r.body.canonical + " verified" + extra);
          } else if (r.status === 401) {
            setState(input, "ok", "Format OK — we'll verify on submit");
          } else {
            var code = (r.body && r.body.code) || "";
            setState(input, "error", copyFor(code, r.body && r.body.error));
          }
        })
        .catch(function () {
          /* network/abort — stay quiet, submit still validates server-side */
          try {
            var s = input.__tv.status;
            if (s && s.className.indexOf("tv-error") === -1 && s.className.indexOf("tv-verified") === -1)
              setState(input, "ok", "Format OK — we'll verify on submit");
          } catch (e) {}
        });
    }, 350);
  }

  /* ------------------------------------------------------ button spinner (#108/#109) */
  var lastButton = null;
  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest("button") : null;
      if (btn) lastButton = btn;
    },
    true
  );

  function setLoading(btn, on) {
    if (!btn) return;
    if (on) {
      if (btn.classList.contains("tv-btn-loading")) return;
      btn.classList.add("tv-btn-loading");
      btn.setAttribute("aria-busy", "true");
      var sp = document.createElement("span");
      sp.className = "tv-btn-spinner";
      sp.setAttribute("aria-hidden", "true");
      btn.appendChild(sp);
      btn.__tvSpin = sp;
    } else {
      btn.classList.remove("tv-btn-loading");
      btn.removeAttribute("aria-busy");
      if (btn.__tvSpin && btn.__tvSpin.parentNode) btn.__tvSpin.parentNode.removeChild(btn.__tvSpin);
      btn.__tvSpin = null;
    }
  }

  /* --------------------------------------------------- fetch interception (#106/#107) */
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var input = arguments[0];
      var init = arguments[1];
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = String(
        (init && init.method) || (input && input.method) || "GET"
      ).toUpperCase();
      var pathOnly = url.split("?")[0];
      var isIntake =
        ((method === "POST" || method === "PUT") && INTAKE_RE.test(pathOnly)) ||
        (method === "POST" && /\/api\/channels\/verify$/.test(pathOnly));

      if (!isIntake) return origFetch.apply(this, arguments);

      var btn = lastButton;
      var isVerify = /\/api\/channels\/verify$/.test(pathOnly);
      if (!isVerify) setLoading(btn, true); /* #109 exact clicked button */

      return origFetch.apply(this, arguments).then(
        function (res) {
          if (!isVerify) setLoading(btn, false); /* #108 re-enable after flight */
          if (res.status === 400 || res.status === 429) {
            res
              .clone()
              .json()
              .then(function (j) {
                if (!j || !j.code) return; /* not our contract — stay silent */
                var msg = copyFor(j.code, j.error);
                toast(msg, "error"); /* #110, #106 */
                var target = pickInput(btn); /* #107 */
                if (target) {
                  setState(target, "error", msg); /* #105: value untouched */
                  if (target.focus) {
                    try {
                      target.focus({ preventScroll: false });
                    } catch (e) { target.focus(); }
                  }
                }
              })
              .catch(function () {});
          } else if (res.status === 200 || res.status === 201) {
            if (!isVerify && INTAKE_RE.test(pathOnly)) {
              var okIn = pickInput(btn);
              if (okIn && okIn.value && normalize(okIn.value).code === null) {
                setState(okIn, "verified", "Verified \u2014 saved");
              }
            }
          }
          return res;
        },
        function (err) {
          if (!isVerify) setLoading(btn, false);
          throw err;
        }
      );
    };
  }

  /* --------------------------------------------------------- scanning loop */
  function scan() {
    var inputs = document.querySelectorAll("input[type=text], input:not([type])");
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var ph = inp.getAttribute("placeholder") || "";
      if (PLACEHOLDERS[ph]) enhance(inp);
      else if (inp.__tv && inp.__tv.status && inp.__tv.status.parentNode === null) {
        /* React re-rendered — re-attach our nodes */
        inp.parentNode.insertBefore(inp.__tv.helper, inp.nextSibling);
        inp.parentNode.insertBefore(inp.__tv.status, inp.__tv.helper.nextSibling);
      }
    }
  }

  scan();
  var mo = typeof MutationObserver !== "undefined" ? new MutationObserver(function () { scan(); }) : null;
  if (mo) mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(scan, 800);
  setTimeout(scan, 2500);
})();
