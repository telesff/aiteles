/**
 * TELES ADS — Wallet (planworkv1 Phase 3, option B: full credits wallet)
 *
 * Loaded from index.html (defer) — same zero-rebuild pattern as teles-enhancements.js
 * and teles-validation.js. Adds, without touching the existing UI:
 *   1. "Wallet" row in Profile (matches the existing menu rows exactly)
 *   2. Wallet overlay: balance, ledger history, top-up form (same payment
 *      methods/addresses as the existing payment screen), proof submission
 *   3. Auto-opens on 402 INSUFFICIENT_BALANCE from campaign checkout
 *
 * Skills applied (W2): vercel web-design-guidelines (labels, aria-live,
 * focus-visible, Intl.NumberFormat/DateTimeFormat, "…" endings, tabular-nums,
 * no transition:all, confirmation-free but destructive-safe, touch-action),
 * emilkowalski mobile-native (16px inputs, :active press feedback, hover gated
 * by capability, overscroll contain, tap-highlight, user-select on controls,
 * safe-area insets), emilkowalski animate (drawer curve
 * cubic-bezier(0.32,0.72,0,1) at 280ms, reduced-motion = opacity only).
 * Brand theme (blue/white Telegram) and layout stay untouched (W1 / keep-old).
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ tokens */
  var PAY_METHODS = {
    usdt_trc20: { name: "USDT (TRC20)", network: "Tron Network", address: "TDhNivo7HsfKu2jmxyjKBWXgkR9pn8dJPf" },
    usdt_bep20: { name: "USDT (BEP20)", network: "BSC Network", address: "0x0fa48b8d8379e1ac7f6b8c5cff3d8d8c419492a9" },
    btcb_bep20: { name: "BTCB (BEP20)", network: "BSC Network", address: "0x0fa48b8d8379e1ac7f6b8c5cff3d8d8c419492a9" },
  };
  var KIND_LABEL = {
    topup: "Top-up",
    spend: "Campaign purchase",
    refund: "Refund",
    direct_payment: "Payment",
    adjustment: "Adjustment",
  };
  var usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initDataHeader() {
    return (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initDataHeader() },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    });
  }

  /* -------------------------------------------------------------------- CSS */
  var CSS = [
    ".tw-root{position:fixed;inset:0;z-index:1100;background:linear-gradient(180deg,#f7faff 0%,#e9f1ff 100%);",
    "  color:#0f172a;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;visibility:hidden;pointer-events:none;",
    "  padding:env(safe-area-inset-top,0px) 0 calc(24px + env(safe-area-inset-bottom,0px));",
    "  transform:translateY(100%);transition:transform 280ms cubic-bezier(0.32,0.72,0,1),opacity 200ms ease-out,visibility 0s linear 280ms;opacity:0;}",
    ".tw-root.tw-open{visibility:visible;pointer-events:auto;transform:translateY(0);opacity:1;transition:transform 280ms cubic-bezier(0.32,0.72,0,1),opacity 200ms ease-out,visibility 0s;}",
    ".tw-root *{-webkit-tap-highlight-color:transparent;box-sizing:border-box;}",
    ".tw-btn{touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}",
    ".tw-btn:active{transform:scale(0.97);}",
    ".tw-focus:focus-visible{outline:2px solid #3b5bff;outline-offset:2px;}",
    "@media (hover:hover) and (pointer:fine){.tw-hover:hover{background:rgba(0,0,0,0.03);}}",
    ".tw-head{display:flex;align-items:center;gap:12px;padding:16px 20px 12px;border-bottom:1px solid rgba(15,23,42,0.06);}",
    ".tw-back{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border:0;background:#fff;border-radius:999px;",
    "  box-shadow:0 2px 10px rgba(15,23,42,0.08);color:#0f172a;cursor:pointer;transition:transform 120ms ease-out;}",
    ".tw-title{font-size:26px;font-weight:700;letter-spacing:-0.02em;margin:0;text-wrap:balance;}",
    ".tw-wrap{padding:16px 20px;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:16px;}",
    ".tw-card{background:rgba(255,255,255,0.82);border:1px solid rgba(255,255,255,0.9);border-radius:24px;padding:24px;",
    "  box-shadow:0 8px 30px rgba(59,91,255,0.06);backdrop-filter:blur(8px);}",
    ".tw-label{font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin:0 0 6px;}",
    ".tw-amount{font-size:42px;font-weight:700;color:#3b5bff;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;margin:0;}",
    ".tw-sub{font-size:14px;color:#64748b;margin:8px 0 0;}",
    ".tw-primary{width:100%;border:0;border-radius:16px;padding:15px;font-size:16px;font-weight:600;color:#fff;cursor:pointer;",
    "  background:linear-gradient(90deg,#3b5bff,#6d8bff);box-shadow:0 6px 22px rgba(59,91,255,0.35);",
    "  transition:transform 120ms ease-out,box-shadow 150ms ease-out;}",
    ".tw-primary:disabled{opacity:0.55;cursor:default;}",
    ".tw-ghost{width:100%;border:1px solid rgba(59,91,255,0.25);border-radius:16px;padding:14px;font-size:15px;font-weight:600;",
    "  color:#3b5bff;background:#fff;cursor:pointer;transition:transform 120ms ease-out,background 150ms ease-out;}",
    ".tw-banner{display:flex;gap:10px;align-items:flex-start;background:#fff7ed;border:1px solid #fed7aa;border-radius:16px;",
    "  padding:14px 16px;font-size:14px;color:#9a3412;line-height:1.45;}",
    ".tw-banner b{font-variant-numeric:tabular-nums;}",
    ".tw-banner button{margin-left:auto;border:0;background:transparent;color:#c2410c;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;}",
    ".tw-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 4px;border-bottom:1px solid rgba(15,23,42,0.05);}",
    ".tw-row:last-child{border-bottom:0;}",
    ".tw-row-main{min-width:0;}",
    ".tw-row-title{font-size:15px;font-weight:600;color:#1e293b;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".tw-row-meta{font-size:12.5px;color:#94a3b8;margin:3px 0 0;}",
    ".tw-row-amt{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;}",
    ".tw-pos{color:#16a34a;}.tw-neg{color:#0f172a;}",
    ".tw-empty{text-align:center;color:#94a3b8;font-size:14px;padding:22px 8px;}",
    ".tw-chips{display:flex;flex-wrap:wrap;gap:8px;}",
    ".tw-chip{border:1px solid rgba(59,91,255,0.25);background:#fff;color:#3b5bff;border-radius:999px;padding:9px 16px;",
    "  font-size:14px;font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums;",
    "  transition:transform 120ms ease-out,background 150ms ease-out,border-color 150ms ease-out;}",
    ".tw-chip[aria-pressed=true]{background:#3b5bff;border-color:#3b5bff;color:#fff;}",
    ".tw-field{display:flex;flex-direction:column;gap:6px;}",
    ".tw-field label{font-size:13.5px;font-weight:600;color:#334155;}",
    ".tw-input{font-size:16px;padding:13px 14px;border:1px solid rgba(148,163,184,0.4);border-radius:14px;background:#fff;color:#0f172a;",
    "  width:100%;font-variant-numeric:tabular-nums;transition:border-color 150ms ease-out,box-shadow 150ms ease-out;}",
    ".tw-input:focus{outline:none;border-color:#3b5bff;box-shadow:0 0 0 3px rgba(59,91,255,0.15);}",
    ".tw-input:focus-visible{outline:none;}",
    ".tw-method{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1.5px solid rgba(148,163,184,0.35);",
    "  background:#fff;border-radius:16px;padding:13px 14px;cursor:pointer;transition:transform 120ms ease-out,border-color 150ms ease-out;}",
    ".tw-method[aria-pressed=true]{border-color:#3b5bff;background:#f5f8ff;}",
    ".tw-method-name{font-size:14.5px;font-weight:600;color:#1e293b;}",
    ".tw-method-net{font-size:12.5px;color:#64748b;margin-top:2px;}",
    ".tw-addr{display:flex;gap:8px;align-items:center;background:#f1f5f9;border-radius:14px;padding:10px 12px;}",
    ".tw-addr code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#334155;overflow:hidden;",
    "  text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;user-select:all;-webkit-user-select:all;}",
    ".tw-copy{border:0;background:#3b5bff;color:#fff;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;",
    "  flex-shrink:0;transition:transform 120ms ease-out;}",
    ".tw-hint{font-size:13px;color:#64748b;line-height:1.5;margin:0;}",
    ".tw-status{font-size:14px;color:#16a34a;font-weight:600;min-height:20px;margin:0;}",
    ".tw-err{font-size:14px;color:#dc2626;font-weight:600;min-height:20px;margin:0;}",
    ".tw-sep{font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin:6px 0 -4px;}",
    ".tw-done{text-align:center;padding:36px 8px 10px;}",
    ".tw-done-icon{width:64px;height:64px;border-radius:999px;background:#ecfdf5;color:#16a34a;display:flex;align-items:center;",
    "  justify-content:center;margin:0 auto 16px;}",
    "@media (prefers-reduced-motion:reduce){",
    "  .tw-root{transition:opacity 150ms ease-out;transform:none !important;}",
    "  .tw-btn:active,.tw-primary,.tw-chip,.tw-method,.tw-copy,.tw-back{transition:none;transform:none !important;}}",
  ].join("\n");

  /* ------------------------------------------------------------------- state */
  var state = { open: false, view: "main", wallet: null, method: "usdt_trc20", banner: "", prevFocus: null, busy: false };
  var rootEl = null, statusEl = null;

  /* ------------------------------------------------------------------- views */
  function headerHtml(title) {
    return (
      '<div class="tw-head">' +
      '<button class="tw-back tw-btn tw-focus" id="tw-close" aria-label="Close wallet">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>' +
      "</button>" +
      '<h1 class="tw-title" id="tw-title">' + esc(title) + "</h1>" +
      "</div>"
    );
  }

  function historyHtml(w) {
    if (!w.entries || !w.entries.length) {
      return '<div class="tw-empty">No activity yet — top up to get started.</div>';
    }
    return w.entries
      .map(function (e) {
        var amt = Number(e.amountCents) / 100;
        var pos = amt >= 0;
        var title = KIND_LABEL[e.kind] || e.kind;
        var meta = (e.memo ? esc(e.memo) + " · " : "") + dateFmt.format(new Date(e.createdAt));
        return (
          '<div class="tw-row"><div class="tw-row-main">' +
          '<p class="tw-row-title">' + esc(title) + "</p>" +
          '<p class="tw-row-meta">' + meta + "</p></div>" +
          '<span class="tw-row-amt ' + (pos ? "tw-pos" : "tw-neg") + '">' + (pos ? "+" : "\u2212") + usd.format(Math.abs(amt)) + "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function mainHtml() {
    var w = state.wallet || { balanceCents: 0, exists: false, entries: [] };
    var banner = "";
    if (state.banner) {
      banner =
        '<div class="tw-banner" role="status"><span>' + state.banner + "</span>" +
        '<button type="button" id="tw-banner-x" aria-label="Dismiss message">\u00d7</button></div>';
    }
    return (
      headerHtml("Wallet") +
      '<div class="tw-wrap">' +
      banner +
      '<div class="tw-card">' +
      '<p class="tw-label">Wallet Balance</p>' +
      '<p class="tw-amount">' + usd.format(Number(w.balanceCents || 0) / 100) + "</p>" +
      '<p class="tw-sub">' + (w.exists ? "Available for campaigns & orders." : "No wallet yet — top up to activate.") + "</p>" +
      "</div>" +
      '<button class="tw-primary tw-btn tw-focus" id="tw-topup-open">Top Up</button>' +
      '<p class="tw-sep">Recent activity</p>' +
      '<div class="tw-card" style="padding:8px 16px;">' + historyHtml(w) + "</div>" +
      "</div>"
    );
  }

  function topupHtml() {
    var m = PAY_METHODS[state.method];
    var chips = [25, 50, 100, 199]
      .map(function (v) {
        return '<button type="button" class="tw-chip tw-btn tw-focus" data-amt="' + v + '" aria-pressed="false">$' + v + "</button>";
      })
      .join("");
    var methods = Object.keys(PAY_METHODS)
      .map(function (k) {
        var mm = PAY_METHODS[k];
        return (
          '<button type="button" class="tw-method tw-btn tw-focus" data-method="' + k + '" aria-pressed="' + (k === state.method) + '">' +
          '<span style="flex:1;min-width:0;"><span class="tw-method-name">' + esc(mm.name) + "</span>" +
          '<span class="tw-method-net" style="display:block;">' + esc(mm.network) + "</span></span></button>"
        );
      })
      .join("");
    return (
      headerHtml("Top Up") +
      '<div class="tw-wrap">' +
      '<div class="tw-card" style="display:flex;flex-direction:column;gap:14px;">' +
      '<div class="tw-field"><label for="tw-amount">Amount (USD)</label>' +
      '<input class="tw-input tw-focus" id="tw-amount" type="number" inputmode="decimal" min="1" max="100000" step="0.01" ' +
      'placeholder="e.g. 50.00…" autocomplete="off" name="tw-amount"></div>' +
      '<div class="tw-chips" role="group" aria-label="Quick amounts">' + chips + "</div>" +
      "</div>" +
      '<p class="tw-sep">Pay with</p>' +
      '<div style="display:flex;flex-direction:column;gap:8px;" role="group" aria-label="Payment method">' + methods + "</div>" +
      '<div class="tw-addr"><code id="tw-addr" translate="no">' + esc(m.address) + "</code>" +
      '<button type="button" class="tw-copy tw-btn tw-focus" id="tw-copy" aria-label="Copy payment address">Copy</button></div>' +
      '<p class="tw-hint">Send the exact amount to this address, then paste the transaction ID below. ' +
      "Your balance updates after an admin verifies the payment.</p>" +
      '<div class="tw-field"><label for="tw-txid">Transaction ID (TXID)</label>' +
      '<input class="tw-input tw-focus" id="tw-txid" type="text" placeholder="e.g. 0x8f3…c21a or 2f9b…" ' +
      'autocomplete="off" spellcheck="false" name="tw-txid" autocapitalize="none" autocorrect="off"></div>' +
      '<div class="tw-field"><label for="tw-sender">Your sending wallet <span style="font-weight:400;color:#94a3b8;">(optional)</span></label>' +
      '<input class="tw-input tw-focus" id="tw-sender" type="text" placeholder="e.g. TAbc1…" ' +
      'autocomplete="off" spellcheck="false" name="tw-sender" autocapitalize="none" autocorrect="off"></div>' +
      '<p class="tw-err" id="tw-err" role="alert"></p>' +
      '<button class="tw-primary tw-btn tw-focus" id="tw-submit">Submit Top-Up</button>' +
      '<button class="tw-ghost tw-btn tw-focus" id="tw-cancel">Cancel</button>' +
      "</div>"
    );
  }

  function doneHtml(invoice) {
    return (
      headerHtml("Top Up") +
      '<div class="tw-wrap"><div class="tw-card tw-done">' +
      '<div class="tw-done-icon" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>' +
      '<h2 style="font-size:20px;font-weight:700;margin:0 0 6px;">Top-Up Submitted</h2>' +
      '<p class="tw-hint" style="margin:0 auto;max-width:300px;">Invoice <b translate="no">' + esc(invoice.invoice_number) + "</b> — " +
      usd.format(Number(invoice.amount_cents || 0) / 100) + " is pending verification. Your balance updates once an admin approves it.</p>" +
      "</div>" +
      '<button class="tw-primary tw-btn tw-focus" id="tw-done-btn">Back to Wallet</button>' +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ render */
  function render() {
    if (!rootEl) return;
    var html;
    if (state.view === "topup") html = topupHtml();
    else if (state.view === "done" && state.lastInvoice) html = doneHtml(state.lastInvoice);
    else html = mainHtml();
    rootEl.innerHTML = html;
    wire();
  }

  function say(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = isErr ? "tw-err" : "tw-status";
  }

  function loadWallet() {
    return api("/api/wallet").then(function (r) {
      if (r.status === 200 && r.body && r.body.ok !== false) state.wallet = r.body;
      else state.wallet = { balanceCents: 0, exists: false, entries: [] };
      return state.wallet;
    });
  }

  /* ------------------------------------------------------------------- wiring */
  function wire() {
    var closeBtn = rootEl.querySelector("#tw-close");
    if (closeBtn) closeBtn.addEventListener("click", close);

    var bx = rootEl.querySelector("#tw-banner-x");
    if (bx) bx.addEventListener("click", function () { state.banner = ""; render(); });

    var openTu = rootEl.querySelector("#tw-topup-open");
    if (openTu)
      openTu.addEventListener("click", function () {
        state.view = "topup";
        render();
        var el = rootEl.querySelector("#tw-amount");
        if (el) el.focus();
      });

    var cancel = rootEl.querySelector("#tw-cancel");
    if (cancel)
      cancel.addEventListener("click", function () {
        state.view = "main";
        render();
      });

    /* quick amount chips */
    Array.prototype.forEach.call(rootEl.querySelectorAll(".tw-chip[data-amt]"), function (c) {
      c.addEventListener("click", function () {
        var v = c.getAttribute("data-amt");
        Array.prototype.forEach.call(rootEl.querySelectorAll(".tw-chip[data-amt]"), function (o) {
          o.setAttribute("aria-pressed", String(o === c));
        });
        var input = rootEl.querySelector("#tw-amount");
        if (input) input.value = v + ".00";
      });
    });

    /* method select */
    Array.prototype.forEach.call(rootEl.querySelectorAll(".tw-method[data-method]"), function (b) {
      b.addEventListener("click", function () {
        state.method = b.getAttribute("data-method");
        var addr = rootEl.querySelector("#tw-addr");
        if (addr) addr.textContent = PAY_METHODS[state.method].address;
        Array.prototype.forEach.call(rootEl.querySelectorAll(".tw-method[data-method]"), function (o) {
          o.setAttribute("aria-pressed", String(o.getAttribute("data-method") === state.method));
        });
      });
    });

    /* copy address */
    var copyBtn = rootEl.querySelector("#tw-copy");
    if (copyBtn)
      copyBtn.addEventListener("click", function () {
        var text = PAY_METHODS[state.method].address;
        var done = function () {
          copyBtn.textContent = "Copied";
          say("Address copied.");
          setTimeout(function () { copyBtn.textContent = "Copy"; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else done();
      });

    /* submit top-up */
    var submit = rootEl.querySelector("#tw-submit");
    if (submit)
      submit.addEventListener("click", function () {
        if (state.busy) return;
        var errEl = rootEl.querySelector("#tw-err");
        var amountEl = rootEl.querySelector("#tw-amount");
        var txid = (rootEl.querySelector("#tw-txid") || {}).value || "";
        var sender = (rootEl.querySelector("#tw-sender") || {}).value || "";
        var usdAmount = parseFloat((amountEl && amountEl.value) || "");
        if (!usdAmount || !(usdAmount >= 1) || usdAmount > 100000) {
          if (errEl) errEl.textContent = "Enter an amount between $1.00 and $100,000.00.";
          if (amountEl) amountEl.focus();
          return;
        }
        if (errEl) errEl.textContent = "";
        state.busy = true;
        submit.disabled = true;
        submit.textContent = "Submitting…";
        var cents = Math.round(usdAmount * 100);
        api("/api/wallet/topup", {
          method: "POST",
          body: { amountCents: cents, paymentMethod: state.method, txid: txid.trim() || undefined, senderWallet: sender.trim() || undefined },
        })
          .then(function (r) {
            if (r.status !== 201 || !r.body || !r.body.invoice) {
              throw new Error((r.body && (r.body.message || r.body.error)) || "Could not create the top-up. Try again.");
            }
            state.lastInvoice = r.body.invoice;
            state.view = "done";
            render();
            loadWallet();
          })
          .catch(function (e) {
            if (errEl) errEl.textContent = e && e.message ? e.message : "Something went wrong. Please try again.";
            submit.disabled = false;
            submit.textContent = "Submit Top-Up";
          })
          .then(function () { state.busy = false; });
      });

    var doneBtn = rootEl.querySelector("#tw-done-btn");
    if (doneBtn)
      doneBtn.addEventListener("click", function () {
        state.view = "main";
        state.banner = "";
        loadWallet().then(render);
      });
  }

  /* ------------------------------------------------------------------ open/close */
  function open(opts) {
    opts = opts || {};
    if (!rootEl) return;
    state.banner = opts.banner || "";
    state.view = "main";
    if (!state.open) state.prevFocus = document.activeElement;
    rootEl.classList.add("tw-open");
    rootEl.setAttribute("aria-hidden", "false");
    state.open = true;
    document.body.style.overflow = "hidden";
    render();
    loadWallet().then(function () {
      if (state.view === "main") render();
      var back = rootEl.querySelector("#tw-close");
      if (back) back.focus({ preventScroll: true });
    });
  }

  function close() {
    if (!rootEl || !state.open) return;
    rootEl.classList.remove("tw-open");
    rootEl.setAttribute("aria-hidden", "true");
    state.open = false;
    document.body.style.overflow = "";
    setTimeout(function () {
      if (!state.open && rootEl) rootEl.innerHTML = "";
    }, 320);
    if (state.prevFocus && state.prevFocus.focus) {
      try { state.prevFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    state.prevFocus = null;
  }

  /* ------------------------------------------------------------ profile row */
  var ROW_ID = "tw-wallet-row";
  function injectRow() {
    if (document.getElementById(ROW_ID)) return;
    var invoices = null;
    var anchors = document.querySelectorAll('a[href="/invoices"]');
    for (var i = 0; i < anchors.length; i++) {
      if ((anchors[i].textContent || "").indexOf("Invoices") !== -1) { invoices = anchors[i]; break; }
    }
    if (!invoices || !invoices.parentNode) return;
    var row = document.createElement("button");
    row.id = ROW_ID;
    row.type = "button";
    row.className = "flex items-center justify-between p-4 hover:bg-black/[0.03] transition-colors active:scale-[0.99] w-full text-left tw-btn";
    row.innerHTML =
      '<div class="flex items-center gap-3">' +
      '<div class="w-8 h-8 rounded-xl glass-btn flex items-center justify-center">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wallet w-4 h-4 text-slate-600" aria-hidden="true">' +
      '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>' +
      "</div>" +
      '<span class="font-medium text-sm text-slate-800">Wallet</span></div>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right w-4 h-4 text-slate-300" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
    row.addEventListener("click", function () { open(); });
    invoices.parentNode.insertBefore(row, invoices.nextSibling);
  }

  /* --------------------------------------------------- 402 checkout hook */
  function hookCheckout() {
    if (!window.fetch || window.__twFetchHooked) return;
    window.__twFetchHooked = true;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      return orig.apply(this, arguments).then(function (res) {
        try {
          var url = typeof input === "string" ? input : (input && input.url) || "";
          var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
          if (res.status === 402 && method === "POST" && /\/api\/campaigns(\?|$)/.test(url)) {
            res
              .clone()
              .json()
              .then(function (b) {
                if (b && b.code === "INSUFFICIENT_BALANCE") {
                  var need = typeof b.requiredCents === "number" ? b.requiredCents : 0;
                  var have = typeof b.balanceCents === "number" ? b.balanceCents : 0;
                  var banner =
                    "Your balance is too low for this campaign" +
                    (need ? " — you need " + usd.format(need / 100) + " (have " + usd.format(have / 100) + ")" : "") +
                    ". Top up below, then try again.";
                  open({ banner: banner });
                }
              })
              .catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  /* -------------------------------------------------------------------- boot */
  function boot() {
    if (document.getElementById("tw-style")) return;
    var style = document.createElement("style");
    style.id = "tw-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    rootEl = document.createElement("div");
    rootEl.id = "tw-wallet";
    rootEl.className = "tw-root tw-focus";
    rootEl.setAttribute("role", "dialog");
    rootEl.setAttribute("aria-modal", "true");
    rootEl.setAttribute("aria-labelledby", "tw-title");
    rootEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(rootEl);

    statusEl = document.createElement("div");
    statusEl.id = "tw-live";
    statusEl.className = "tw-status";
    statusEl.setAttribute("aria-live", "polite");
    statusEl.style.position = "absolute";
    statusEl.style.width = "1px";
    statusEl.style.height = "1px";
    statusEl.style.overflow = "hidden";
    statusEl.style.clip = "rect(0 0 0 0)";
    statusEl.style.whiteSpace = "nowrap";
    document.body.appendChild(statusEl);

    hookCheckout();
    injectRow();

    var mo = new MutationObserver(function () { injectRow(); });
    mo.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) close();
    });

    window.__telesWallet = { open: open, close: close };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
