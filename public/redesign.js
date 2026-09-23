/**
 * TELES ADS — Home redesign enhancer (v1)
 * Adds scope markers + tiny UX wins without touching React logic:
 *  - .rd-home  → dashboard content stack (scoped styles)
 *  - .rd-shell → phone frame (aurora orbs)
 *  - .rd-nav   → bottom navigation + .rd-on active item
 *  - copy toast with aria-live="polite" (feedback for the referral button)
 * Idempotent + SPA-route aware (pushState/popState/MutationObserver).
 */
(function () {
  "use strict";

  var ORB_A = "rd-orb rd-orb-a";
  var ORB_B = "rd-orb rd-orb-b";

  function isHome() {
    var p = location.pathname.replace(/\/+$/, "") || "/";
    return p === "/home";
  }

  function ensureOrbs(shell) {
    if (!shell) return;
    if (!shell.querySelector(".rd-orb-a")) {
      var a = document.createElement("div");
      a.className = ORB_A;
      a.setAttribute("aria-hidden", "true");
      shell.insertBefore(a, shell.firstChild);
    }
    if (!shell.querySelector(".rd-orb-b")) {
      var b = document.createElement("div");
      b.className = ORB_B;
      b.setAttribute("aria-hidden", "true");
      shell.insertBefore(b, shell.firstChild);
    }
  }

  function removeOrbs(shell) {
    if (!shell) return;
    [".rd-orb-a", ".rd-orb-b"].forEach(function (sel) {
      var el = shell.querySelector(sel);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function apply() {
    var home = isHome();

    // Content scope marker
    var content = document.querySelector("main > div > div.p-4");
    if (content) content.classList.toggle("rd-home", home);

    // Shell marker + aurora orbs (home only)
    var main = document.querySelector("main");
    var shell = main ? main.parentElement : null;
    if (shell) {
      shell.classList.toggle("rd-shell", home);
      if (home) ensureOrbs(shell);
      else removeOrbs(shell);
    }

    // Bottom nav marker + active state
    var nav = document.querySelector("nav");
    if (nav) {
      nav.classList.add("rd-nav");
      var path = location.pathname.replace(/\/+$/, "") || "/";
      nav.querySelectorAll("a[href]").forEach(function (a) {
        var href = (a.getAttribute("href") || "").replace(/\/+$/, "") || "/";
        a.classList.toggle("rd-on", href === path);
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Copy toast — feedback when the referral copy button is pressed
   * ------------------------------------------------------------------ */
  var toastTimer = null;
  function showToast(text) {
    var old = document.querySelector(".rd-toast");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var t = document.createElement("div");
    t.className = "rd-toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    t.textContent = text;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.add("rd-toast-out");
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 200);
    }, 1600);
  }

  document.addEventListener(
    "click",
    function (e) {
      var btn = e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      var host = btn.closest(".glass-input");
      if (host && host.querySelector("span.font-mono")) {
        showToast("Link copied ✓");
        try {
          if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
            window.Telegram.WebApp.HapticFeedback.impactOccurred("light");
          }
        } catch (err) {}
      }
    },
    true /* capture: fire even if React calls stopPropagation */
  );

  /* ------------------------------------------------------------------ *
   * Route watching — re-apply markers on SPA navigation
   * ------------------------------------------------------------------ */
  function start() {
    apply();
    setInterval(apply, 600);
    new MutationObserver(apply).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("popstate", apply);
    var _push = history.pushState;
    history.pushState = function () {
      _push.apply(this, arguments);
      setTimeout(apply, 0);
    };
    var _replace = history.replaceState;
    history.replaceState = function () {
      _replace.apply(this, arguments);
      setTimeout(apply, 0);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
