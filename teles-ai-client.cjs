"use strict";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

function splitList(...values) {
  const seen = new Set();
  const items = [];
  for (const value of values) {
    for (const item of String(value || "").split(/[\n,;]+/)) {
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        items.push(trimmed);
      }
    }
  }
  return items;
}

function rotate(items, offset) {
  if (!items.length) return [];
  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

function safeTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(45_000, Math.max(3_000, parsed)) : 15_000;
}

function createAiClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const appUrl = options.appUrl || env.APP_URL || "https://egatusad.com";
  const timeoutMs = safeTimeout(options.timeoutMs || env.AI_REQUEST_TIMEOUT_MS);
  const openRouterKeys = splitList(env.OPENROUTER_API_KEYS, env.OPENROUTER_API_KEY);
  const nvidiaKeys = splitList(env.NVIDIA_API_KEYS, env.NVIDIA_API_KEY);
  const openRouterModels = splitList(env.OPENROUTER_MODELS);
  const nvidiaModels = splitList(env.NVIDIA_MODELS);
  const orModels = openRouterModels.length ? openRouterModels : ["openrouter/free"];
  const nvModels = nvidiaModels.length ? nvidiaModels : ["meta/llama-3.1-8b-instruct"];
  let requestNumber = 0;

  async function attempt(provider, key, keyIndex, keyCount, model, messages) {
    const isOpenRouter = provider === "OpenRouter";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(isOpenRouter ? OPENROUTER_URL : NVIDIA_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          ...(isOpenRouter ? { "HTTP-Referer": appUrl, "X-Title": "Teles Agent" } : {}),
        },
        body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.7 }),
      });
      if (!response.ok) {
        logger.warn?.(
          `Teles Agent: ${provider} credential ${keyIndex + 1}/${keyCount} failed with HTTP ${response.status}.`
        );
        return {
          ok: false,
          providerUnavailable: response.status >= 500,
          error: `HTTP ${response.status}`,
        };
      }
      const data = await response.json().catch(() => ({}));
      const text = responseText(data);
      if (!text) {
        logger.warn?.(
          `Teles Agent: ${provider} credential ${keyIndex + 1}/${keyCount} returned an empty response.`
        );
        return { ok: false, providerUnavailable: false, error: "empty response" };
      }
      return { ok: true, text, model, provider };
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timeout" : "network error";
      logger.warn?.(`Teles Agent: ${provider} ${reason}; switching provider.`);
      return { ok: false, providerUnavailable: true, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  async function complete(messages) {
    if (!openRouterKeys.length && !nvidiaKeys.length) {
      return {
        ok: false,
        text: "🤖 Teles Agent is not configured yet. The admin needs to configure an OpenRouter or NVIDIA API key.",
      };
    }

    const sequence = requestNumber++;
    const providers = [
      { name: "OpenRouter", keys: rotate(openRouterKeys, sequence), models: orModels },
      { name: "NVIDIA", keys: rotate(nvidiaKeys, sequence), models: nvModels },
    ];
    let lastError = "no credentials";

    for (const provider of providers) {
      for (let index = 0; index < provider.keys.length; index += 1) {
        const model = provider.models[(sequence + index) % provider.models.length];
        const result = await attempt(
          provider.name,
          provider.keys[index],
          index,
          provider.keys.length,
          model,
          messages
        );
        if (result.ok) return result;
        lastError = `${provider.name}: ${result.error}`;
        if (result.providerUnavailable) break;
      }
    }

    logger.error?.(`Teles Agent: every configured AI provider failed (${lastError}).`);
    return {
      ok: false,
      text: "😔 Teles Agent is a bit overloaded right now. Please try again in a minute!",
    };
  }

  return {
    complete,
    credentialCounts: { openRouter: openRouterKeys.length, nvidia: nvidiaKeys.length },
  };
}

module.exports = { createAiClient, responseText, splitList };
