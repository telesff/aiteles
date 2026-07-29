/**
 * TELES ADS — UI Enhancements (loaded from index.html, no rebuild needed)
 * 1. Random user avatar (1 of 9) + avatar picker (tap your avatar in Profile)
 * 2. Teles Agent — floating AI chat widget powered by OpenRouter (/api/agent/chat)
 */
(function () {
  "use strict";

  var AVATAR_COUNT = 9;
  var DEFAULT_AVATAR = "/images/avatar.png";

  /* ---------------------------------------------------------------------
   * User identity (per-Telegram-user storage keys)
   * ------------------------------------------------------------------- */
  function tgUserId() {
    try {
      var u =
        window.Telegram &&
        window.Telegram.WebApp &&
        window.Telegram.WebApp.initDataUnsafe &&
        window.Telegram.WebApp.initDataUnsafe.user;
      return u && u.id ? String(u.id) : "guest";
    } catch (e) {
      return "guest";
    }
  }

  function storageKey() {
    return "teles_avatar_" + tgUserId();
  }

  function avatarUrl(n) {
    return "/images/avatars/avatar-" + n + ".jpg";
  }

  function getChosenAvatar() {
    var v = null;
    try {
      v = localStorage.getItem(storageKey());
    } catch (e) {}
    var n = parseInt(v, 10);
    if (!n || n < 1 || n > AVATAR_COUNT) {
      // First visit: assign randomly, then persist so it stays stable.
      n = 1 + Math.floor(Math.random() * AVATAR_COUNT);
      try {
        localStorage.setItem(storageKey(), String(n));
      } catch (e) {}
    }
    return n;
  }

  function setChosenAvatar(n) {
    try {
      localStorage.setItem(storageKey(), String(n));
    } catch (e) {}
    applyAvatar();
  }

  /* ---------------------------------------------------------------------
   * Apply avatar to every default-avatar <img> the React app renders
   * ------------------------------------------------------------------- */
  function applyAvatar() {
    var chosen = avatarUrl(getChosenAvatar());
    var imgs = document.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute("src") || "";
      var isAvatar =
        src === DEFAULT_AVATAR ||
        src.indexOf("/images/avatars/avatar-") === 0 ||
        (img.getAttribute("alt") || "").toLowerCase() === "avatar";
      if (isAvatar) {
        if (src !== chosen) img.setAttribute("src", chosen);
        if (!img.__telesPickerBound) {
          img.__telesPickerBound = true;
          img.style.cursor = "pointer";
          img.addEventListener("click", openAvatarPicker);
        }
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Avatar picker modal
   * ------------------------------------------------------------------- */
  var pickerEl = null;

  function openAvatarPicker(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (pickerEl) return;
    var current = getChosenAvatar();

    pickerEl = document.createElement("div");
    pickerEl.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:99990",
      "background:rgba(6,11,36,.45)", "backdrop-filter:blur(6px)",
      "-webkit-backdrop-filter:blur(6px)",
      "display:flex", "align-items:center", "justify-content:center",
      "padding:24px",
    ].join(";"));

    var card = document.createElement("div");
    card.setAttribute("style", [
      "background:rgba(255,255,255,.92)", "backdrop-filter:blur(18px)",
      "-webkit-backdrop-filter:blur(18px)",
      "border:1px solid rgba(255,255,255,.8)", "border-radius:24px",
      "box-shadow:0 12px 48px rgba(0,0,0,.25)",
      "max-width:340px", "width:100%", "padding:20px",
      "font-family:Inter,system-ui,sans-serif",
    ].join(";"));

    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
      '<div style="font-weight:700;font-size:16px;color:#1e293b">Choose your avatar</div>' +
      '<button id="teles-picker-close" style="border:0;background:rgba(0,0,0,.06);border-radius:10px;width:30px;height:30px;font-size:15px;cursor:pointer;color:#475569">✕</button>' +
      "</div>" +
      '<div id="teles-picker-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px"></div>';

    pickerEl.appendChild(card);
    document.body.appendChild(pickerEl);

    var grid = card.querySelector("#teles-picker-grid");
    for (var n = 1; n <= AVATAR_COUNT; n++) {
      (function (num) {
        var b = document.createElement("button");
        var selected = num === current;
        b.setAttribute("style", [
          "border-radius:16px", "overflow:hidden", "padding:0", "cursor:pointer",
          "aspect-ratio:1/1", "background:#eef2f7",
          "border:3px solid " + (selected ? "#1f8fff" : "transparent"),
          "box-shadow:" + (selected ? "0 0 0 3px rgba(31,143,255,.25)" : "none"),
          "transition:transform .12s",
        ].join(";"));
        b.innerHTML =
          '<img src="' + avatarUrl(num) + '" alt="Avatar ' + num +
          '" style="width:100%;height:100%;object-fit:cover;display:block">';
        b.addEventListener("click", function () {
          setChosenAvatar(num);
          closeAvatarPicker();
          try {
            if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback)
              window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
          } catch (e) {}
        });
        grid.appendChild(b);
      })(n);
    }

    card.querySelector("#teles-picker-close").addEventListener("click", closeAvatarPicker);
    pickerEl.addEventListener("click", function (e) {
      if (e.target === pickerEl) closeAvatarPicker();
    });
  }

  function closeAvatarPicker() {
    if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
    pickerEl = null;
  }

  /* ---------------------------------------------------------------------
   * Teles Agent chat widget
   * ------------------------------------------------------------------- */
  var chatOpen = false;
  var chatHistory = [];
  try {
    var savedHist = sessionStorage.getItem("teles_agent_history");
    if (savedHist) chatHistory = JSON.parse(savedHist) || [];
  } catch (e) {}

  function saveHistory() {
    try {
      sessionStorage.setItem("teles_agent_history", JSON.stringify(chatHistory.slice(-16)));
    } catch (e) {}
  }

  function el(tag, style, html) {
    var node = document.createElement(tag);
    if (style) node.setAttribute("style", style);
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdownLite(s) {
    var t = escapeHtml(s);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/`([^`\n]+)`/g, '<code style="background:rgba(0,0,0,.07);border-radius:4px;padding:1px 4px">$1</code>');
    t = t.replace(/^\s*[-*]\s+/gm, "• ");
    t = t.replace(/\n/g, "<br>");
    return t;
  }

  var fab, panel, msgsBox, inputEl, sendBtn;

  function buildWidget() {
    // Floating action button
    fab = el("button", [
      "position:fixed", "right:16px", "bottom:104px", "z-index:99980",
      "width:56px", "height:56px", "border-radius:50%", "border:0", "cursor:pointer",
      "background:linear-gradient(135deg,#1f8fff,#4fb2ff)",
      "box-shadow:0 8px 24px rgba(31,143,255,.45)",
      "display:flex", "align-items:center", "justify-content:center",
      "font-size:26px", "color:#fff", "transition:transform .15s",
    ].join(";"), "🤖");
    fab.title = "Teles Agent — AI Assistant";
    fab.addEventListener("click", toggleChat);
    document.body.appendChild(fab);

    // Chat panel
    panel = el("div", [
      "position:fixed", "right:12px", "bottom:170px", "z-index:99985",
      "width:min(360px,calc(100vw - 24px))", "height:min(480px,calc(100vh - 220px))",
      "background:rgba(255,255,255,.94)",
      "backdrop-filter:blur(18px)", "-webkit-backdrop-filter:blur(18px)",
      "border:1px solid rgba(255,255,255,.85)", "border-radius:22px",
      "box-shadow:0 16px 48px rgba(0,0,0,.28)",
      "display:none", "flex-direction:column", "overflow:hidden",
      "font-family:Inter,system-ui,sans-serif",
    ].join(";"));

    var header = el("div", [
      "padding:14px 16px",
      "background:linear-gradient(135deg,#1f8fff,#4fb2ff)",
      "color:#fff", "display:flex", "align-items:center", "gap:10px",
    ].join(";"),
      '<div style="width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:18px">🤖</div>' +
      '<div style="flex:1"><div style="font-weight:700;font-size:14px">Teles Agent</div>' +
      '<div style="font-size:11px;opacity:.85">AI Growth Assistant • online</div></div>' +
      '<button id="teles-chat-close" style="border:0;background:rgba(255,255,255,.2);color:#fff;border-radius:10px;width:28px;height:28px;cursor:pointer;font-size:13px">✕</button>'
    );
    panel.appendChild(header);

    msgsBox = el("div", [
      "flex:1", "overflow-y:auto", "padding:14px",
      "display:flex", "flex-direction:column", "gap:10px",
      "background:linear-gradient(180deg,#f4f8fd,#eef4fb)",
    ].join(";"));
    panel.appendChild(msgsBox);

    var inputBar = el("div", [
      "display:flex", "gap:8px", "padding:12px",
      "background:rgba(255,255,255,.9)", "border-top:1px solid rgba(0,0,0,.05)",
    ].join(";"));
    inputEl = el("input", [
      "flex:1", "border:1px solid rgba(0,0,0,.1)", "border-radius:12px",
      "padding:10px 12px", "font-size:14px", "outline:none",
      "font-family:inherit", "background:#fff", "color:#1e293b",
    ].join(";"));
    inputEl.placeholder = "Ask Teles Agent anything…";
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendMessage();
    });
    sendBtn = el("button", [
      "border:0", "border-radius:12px", "padding:0 16px", "cursor:pointer",
      "background:#1f8fff", "color:#fff", "font-weight:600", "font-size:14px",
    ].join(";"), "➤");
    sendBtn.addEventListener("click", sendMessage);
    inputBar.appendChild(inputEl);
    inputBar.appendChild(sendBtn);
    panel.appendChild(inputBar);

    document.body.appendChild(panel);
    header.querySelector("#teles-chat-close").addEventListener("click", toggleChat);

    // restore history or greet
    if (chatHistory.length) {
      chatHistory.forEach(function (m) {
        addBubble(m.role, m.content, true);
      });
    } else {
      addBubble(
        "assistant",
        "👋 Hey! I'm **Teles Agent**, your AI growth assistant.\n\nAsk me about packages, pricing, or how to grow your trading channel!",
        true
      );
    }
  }

  function toggleChat() {
    chatOpen = !chatOpen;
    panel.style.display = chatOpen ? "flex" : "none";
    fab.innerHTML = chatOpen ? "✕" : "🤖";
    if (chatOpen) {
      msgsBox.scrollTop = msgsBox.scrollHeight;
      inputEl.focus();
    }
  }

  function addBubble(role, text, skipHistory) {
    var isUser = role === "user";
    var b = el("div", [
      "max-width:82%",
      "padding:10px 13px",
      "border-radius:" + (isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px"),
      "font-size:13.5px", "line-height:1.45",
      "align-self:" + (isUser ? "flex-end" : "flex-start"),
      isUser
        ? "background:linear-gradient(135deg,#1f8fff,#4fb2ff);color:#fff"
        : "background:#fff;color:#1e293b;border:1px solid rgba(0,0,0,.06);box-shadow:0 2px 8px rgba(0,0,0,.05)",
      "word-break:break-word",
    ].join(";"), renderMarkdownLite(text));
    msgsBox.appendChild(b);
    msgsBox.scrollTop = msgsBox.scrollHeight;
    if (!skipHistory) {
      chatHistory.push({ role: role, content: text });
      saveHistory();
    }
    return b;
  }

  var pending = false;

  function sendMessage() {
    var text = (inputEl.value || "").trim();
    if (!text || pending) return;
    inputEl.value = "";
    addBubble("user", text);
    pending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = ".5";

    var typing = el("div", [
      "align-self:flex-start", "padding:10px 14px", "border-radius:16px",
      "background:#fff", "border:1px solid rgba(0,0,0,.06)",
      "color:#94a3b8", "font-size:13px",
    ].join(";"), "Teles Agent is typing…");
    msgsBox.appendChild(typing);
    msgsBox.scrollTop = msgsBox.scrollHeight;

    fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: chatHistory.slice(0, -1).slice(-12) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        addBubble("assistant", (data && data.reply) || "Sorry, something went wrong. Try again!");
      })
      .catch(function () {
        typing.remove();
        addBubble("assistant", "⚠️ Connection issue — please try again in a moment.");
      })
      .finally(function () {
        pending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = "1";
      });
  }

  /* ---------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------- */
  function boot() {
    buildWidget();
    applyAvatar();
    // React SPA — watch for re-renders and route changes
    var mo = new MutationObserver(function () {
      applyAvatar();
    });
    mo.observe(document.getElementById("root") || document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
