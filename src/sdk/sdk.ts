/**
 * BundleLLM SDK
 *
 * The easiest way to add AI to your website. Users connect their
 * AI provider via OAuth (OpenRouter) or API key, and your site
 * gets streaming chat. No accounts, no server, one script tag.
 *
 * Usage:
 *   BundleLLM.init().renderChat('#chat', { context: 'Product page...' })
 */

import type {
  BundleLLMConfig,
  BundleLLMInstance,
  RenderChatOptions,
  ChatStream,
  SDKConnectionStatusResult,
  SDKChatRequestInput,
} from "./types";

const DEFAULT_API_URL = "https://api.bundlellm.com";
const STORAGE_KEY = "bundlellm_connection";

// ---- Analytics ----

async function deriveSiteId(): Promise<string> {
  try {
    const origin = window.location.origin;
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(origin));
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return "site_" + hex.slice(0, 16);
  } catch {
    return "site_unknown";
  }
}

function sendEvent(
  apiUrl: string,
  siteId: string,
  event: string,
  data?: Record<string, unknown>,
) {
  fetch(`${apiUrl}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, event, ...data }),
    keepalive: true,
  }).catch(() => {}); // Fire and forget
}

// ---- Provider Config ----

const PROVIDERS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "200+ models — Claude, GPT, Gemini, Llama",
    oauth: true,
    apiBase: "https://openrouter.ai/api/v1",
    models: [
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "google/gemini-2.5-pro-preview", name: "Gemini 2.5 Pro" },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude Sonnet, Haiku, Opus",
    oauth: false,
    apiBase: "https://api.anthropic.com",
    placeholder: "sk-ant-api03-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    ],
  },
];

// ---- Event Emitter ----

type Listener = (...args: unknown[]) => void;

class EventEmitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  off(event: string, cb: Listener) {
    this.listeners.get(event)?.delete(cb);
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  removeAll() {
    this.listeners.clear();
  }
}

// ---- Chat Stream ----

class ChatStreamImpl {
  private emitter = new EventEmitter();
  private abortController: AbortController | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): ChatStream {
    this.emitter.on(event, cb);
    return this as unknown as ChatStream;
  }

  cancel() {
    this.abortController?.abort();
  }

  /** @internal */
  _setAbort(controller: AbortController) {
    this.abortController = controller;
  }
  /** @internal */
  _emit(event: string, ...args: unknown[]) {
    this.emitter.emit(event, ...args);
  }
  /** @internal */
  _cleanup() {
    this.emitter.removeAll();
  }
}

// ---- Stored Connection ----

interface StoredConnection {
  provider: string;
  key: string;
  model?: string;
  storedAt?: number;
}

function loadConnection(sessionTTL?: number): StoredConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.provider !== "string" || typeof parsed.key !== "string") return null;
    if (sessionTTL !== undefined && typeof parsed.storedAt === "number") {
      if (Date.now() - parsed.storedAt > sessionTTL * 1000) {
        clearConnection();
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveConnection(conn: StoredConnection): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...conn, storedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function clearConnection() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ---- Chat Streaming (direct to provider) ----

function streamChat(
  conn: StoredConnection,
  request: SDKChatRequestInput,
  stream: ChatStreamImpl,
  siteId?: string,
  onAuthError?: () => void,
) {
  const controller = new AbortController();
  stream._setAbort(controller);

  const messages = [...request.messages];
  if (request.context) {
    messages.unshift({ role: "system", content: request.context });
  }

  const model = request.model ?? conn.model ?? "anthropic/claude-sonnet-4";

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  if (conn.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": conn.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    // Anthropic format: system separate from messages
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");
    body = {
      model: model,
      messages: nonSystemMsgs,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      ...(systemMsg && { system: systemMsg.content }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };
  } else {
    // OpenAI-compatible format (OpenRouter)
    url = "https://openrouter.ai/api/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${conn.key}`,
      ...(conn.provider === "openrouter" && {
        "HTTP-Referer": "https://bundlellm.com",
        "X-Title": siteId ?? "BundleLLM",
      }),
    };
    body = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };
  }

  const MAX_RETRIES = 3;
  const doFetch = async (attempt: number): Promise<Response> => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, delay));
      return doFetch(attempt + 1);
    }

    return res;
  };

  doFetch(0)
    .then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = (data as { error?: { message?: string } }).error?.message
          ?? (data as { error?: string }).error
          ?? `HTTP ${res.status}`;

        if (res.status === 401 || res.status === 403) {
          stream._emit("error", { message: `Authentication failed: ${message}. Please reconnect.` });
          onAuthError?.();
        } else if (res.status === 429) {
          stream._emit("error", { message: "Rate limited. Please wait a moment and try again." });
        } else {
          stream._emit("error", { message });
        }
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        stream._emit("error", { message: "No response body" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let started = false;
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("data: ")) data = line.slice(6).trim();
          }
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            if (conn.provider === "anthropic") {
              // Anthropic SSE format
              switch (parsed.type) {
                case "message_start":
                  stream._emit("start", { messageId: parsed.message?.id ?? "" });
                  inputTokens = parsed.message?.usage?.input_tokens ?? 0;
                  started = true;
                  break;
                case "content_block_delta":
                  if (parsed.delta?.text) stream._emit("delta", parsed.delta.text);
                  break;
                case "message_delta":
                  outputTokens = parsed.usage?.output_tokens ?? 0;
                  break;
                case "message_stop":
                  stream._emit("done", { usage: { inputTokens, outputTokens } });
                  stream._cleanup();
                  return;
                case "error":
                  stream._emit("error", { message: parsed.error?.message ?? "Stream error" });
                  stream._cleanup();
                  return;
              }
            } else {
              // OpenAI-compatible format (OpenRouter)
              if (!started) {
                stream._emit("start", { messageId: parsed.id ?? "" });
                started = true;
              }
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                stream._emit("delta", delta.content);
              }
              // Capture usage from any chunk (finish chunk or separate usage chunk)
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens ?? 0;
                outputTokens = parsed.usage.completion_tokens ?? 0;
              }
              if (parsed.choices?.[0]?.finish_reason) {
                // Don't emit done yet — usage chunk may follow
                // Will emit done when stream ends
              }
            }
          } catch {}
        }
      }

      // Stream ended without explicit stop
      if (started) {
        stream._emit("done", { usage: { inputTokens, outputTokens } });
        stream._cleanup();
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        stream._emit("error", { message: err.message ?? "Chat failed" });
      }
      stream._cleanup();
    });
}

// ---- SDK Instance ----

class BundleLLMInstanceImpl {
  private emitter = new EventEmitter();
  private connection: StoredConnection | null;
  private apiUrl: string;
  private siteId: string = "";
  private destroyed = false;
  private sdkLoadSent = false;
  private chatContext?: string;
  private documentClickHandler?: () => void;
  private widgetEl?: HTMLElement;
  private signInEl?: HTMLElement;
  private sessionTTL?: number;

  constructor(config?: BundleLLMConfig) {
    this.apiUrl = config?.apiUrl ?? DEFAULT_API_URL;
    this.sessionTTL = config?.sessionTTL !== undefined && config.sessionTTL >= 0
      ? config.sessionTTL
      : undefined;
    this.connection = loadConnection(this.sessionTTL);

    // Derive siteId (async but we don't await — events fire when ready)
    if (config?.siteId) {
      this.siteId = config.siteId;
      this.trackSdkLoad();
    } else {
      deriveSiteId().then((id) => {
        this.siteId = id;
        this.trackSdkLoad();
      });
    }
  }

  private trackSdkLoad() {
    if (this.sdkLoadSent) return;
    this.sdkLoadSent = true;
    sendEvent(this.apiUrl, this.siteId, "sdk_load");
  }

  private track(event: string, data?: Record<string, unknown>) {
    if (!this.siteId) return;
    sendEvent(this.apiUrl, this.siteId, event, data);
  }

  // ---- Public API ----

  renderSignIn(selector: string) {
    if (this.destroyed) return;
    const container = document.querySelector(selector);
    if (!container) return;
    if (this.signInEl) this.signInEl.remove();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = this.buildProviderPickerHTML();
    container.appendChild(wrapper);
    this.signInEl = wrapper;
    this.wireProviderPicker(wrapper);
    this.emitIfConnected();

    // Reset picker on disconnect
    this.on("disconnected", () => {
      wrapper.innerHTML = this.buildProviderPickerHTML();
      this.wireProviderPicker(wrapper);
    });
  }

  renderChat(selector: string, options?: RenderChatOptions) {
    if (this.destroyed) return;
    const container = document.querySelector(selector);
    if (!container) return;

    // Clean up previous renderChat call to prevent listener and DOM leaks
    if (this.widgetEl) {
      this.widgetEl.remove();
    }
    if (this.documentClickHandler) {
      document.removeEventListener("click", this.documentClickHandler);
    }

    const opts = {
      placeholder: options?.placeholder ?? "Ask something...",
      context: options?.context,
      welcomeMessage: options?.welcomeMessage ?? "Connect your AI provider to start chatting.",
      theme: options?.theme ?? "light",
    };

    const isDark = opts.theme === "dark";
    const bg = isDark ? "#1a202c" : "#fff";
    const border = isDark ? "#2d3748" : "#e2e8f0";
    const text = isDark ? "#e2e8f0" : "#1a202c";
    const textMuted = isDark ? "#a0aec0" : "#718096";
    const inputBg = isDark ? "#2d3748" : "#fff";
    const userBubble = "#3182ce";
    const assistantBubble = isDark ? "#2d3748" : "#f7fafc";
    const assistantBorder = isDark ? "#4a5568" : "#e2e8f0";

    const widget = document.createElement("div");
    widget.setAttribute("style", `font-family:system-ui,sans-serif;border:1px solid ${border};border-radius:12px;overflow:hidden;display:flex;flex-direction:column;height:100%;background:${bg};color:${text};`);

    widget.innerHTML = `
      <div style="padding:12px 16px;border-bottom:1px solid ${border};display:flex;align-items:center;gap:8px;">
        <span style="font-size:14px;font-weight:600;">BundleLLM</span>
        <span data-bundlellm="status" style="font-size:12px;color:${textMuted};margin-left:auto;"></span>
        <select data-bundlellm="model-switcher" style="display:none;padding:4px 8px;padding-right:24px;border:1px solid ${border};border-radius:6px;font-size:11px;outline:none;background:${bg};color:${textMuted};appearance:none;background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23718096%22 stroke-width=%222%22><polyline points=%226 9 12 15 18 9%22/></svg>');background-repeat:no-repeat;background-position:right 6px center;max-width:160px;"></select>
        <div style="position:relative;">
          <button data-bundlellm="menu-btn" style="display:none;padding:4px 6px;border:none;background:transparent;cursor:pointer;font-size:18px;line-height:1;color:${textMuted};">&#9776;</button>
          <div data-bundlellm="menu" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:${bg};border:1px solid ${border};border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:10;min-width:120px;overflow:hidden;">
            <button data-bundlellm="clear-chat" style="display:block;width:100%;padding:8px 14px;border:none;background:transparent;color:${text};font-size:13px;cursor:pointer;text-align:left;font-family:system-ui,sans-serif;">Clear chat</button>
            <button data-bundlellm="signout" style="display:block;width:100%;padding:8px 14px;border:none;background:transparent;color:#e53e3e;font-size:13px;cursor:pointer;text-align:left;font-family:system-ui,sans-serif;">Disconnect</button>
          </div>
        </div>
      </div>
      <div data-bundlellm="auth" style="flex:1;overflow-y:auto;padding:16px;">
        <p data-bundlellm="welcome" style="font-size:14px;color:${textMuted};margin-bottom:16px;text-align:center;"></p>
        <div data-bundlellm="provider-picker"></div>
      </div>
      <div data-bundlellm="chat" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
        <div data-bundlellm="messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;"></div>
        <div style="padding:12px;border-top:1px solid ${border};display:flex;gap:8px;">
          <input data-bundlellm="input" type="text" style="flex:1;padding:8px 12px;border:1px solid ${border};border-radius:8px;font-size:14px;outline:none;background:${inputBg};color:${text};">
          <button data-bundlellm="send" style="padding:8px 16px;background:${userBubble};color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500;">Send</button>
        </div>
      </div>
    `;

    container.appendChild(widget);
    this.widgetEl = widget;

    // Set developer-supplied strings via safe DOM methods (not innerHTML)
    const welcomeEl = widget.querySelector('[data-bundlellm="welcome"]') as HTMLElement;
    if (welcomeEl) welcomeEl.textContent = opts.welcomeMessage;
    const inputEl = widget.querySelector('[data-bundlellm="input"]') as HTMLInputElement;
    if (inputEl) inputEl.setAttribute("placeholder", opts.placeholder);

    const authArea = widget.querySelector('[data-bundlellm="auth"]') as HTMLElement;
    const chatArea = widget.querySelector('[data-bundlellm="chat"]') as HTMLElement;
    const messagesEl = widget.querySelector('[data-bundlellm="messages"]') as HTMLElement;
    const sendBtn = widget.querySelector('[data-bundlellm="send"]') as HTMLButtonElement;
    const statusEl = widget.querySelector('[data-bundlellm="status"]') as HTMLElement;
    const menuBtn = widget.querySelector('[data-bundlellm="menu-btn"]') as HTMLButtonElement;
    const menu = widget.querySelector('[data-bundlellm="menu"]') as HTMLElement;
    const signoutBtn = widget.querySelector('[data-bundlellm="signout"]') as HTMLButtonElement;
    const pickerEl = widget.querySelector('[data-bundlellm="provider-picker"]') as HTMLElement;
    const modelSwitcher = widget.querySelector('[data-bundlellm="model-switcher"]') as HTMLSelectElement;

    // Model switcher — update stored model on change
    modelSwitcher.addEventListener("change", () => {
      if (this.connection) {
        this.connection.model = modelSwitcher.value;
        saveConnection(this.connection);
      }
    });

    // Provider picker
    pickerEl.innerHTML = this.buildProviderPickerHTML();
    this.wireProviderPicker(pickerEl);

    // Menu
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.style.display = menu.style.display === "none" ? "block" : "none"; });
    menu.addEventListener("click", (e) => e.stopPropagation());
    this.documentClickHandler = () => (menu.style.display = "none");
    document.addEventListener("click", this.documentClickHandler);
    const clearChatBtn = widget.querySelector('[data-bundlellm="clear-chat"]') as HTMLButtonElement;
    clearChatBtn.addEventListener("click", () => {
      menu.style.display = "none";
      messagesEl.innerHTML = "";
      history.length = 0;
    });
    signoutBtn.addEventListener("click", () => { menu.style.display = "none"; this.disconnect(); });

    // Chat state
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    const showChat = () => {
      authArea.style.display = "none";
      chatArea.style.display = "flex";
      menuBtn.style.display = "inline-block";
      modelSwitcher.style.display = "inline-block";
    };
    const showAuth = () => {
      authArea.style.display = "block";
      chatArea.style.display = "none";
      menuBtn.style.display = "none";
      modelSwitcher.style.display = "none";
      menu.style.display = "none";
      statusEl.textContent = "";
      pickerEl.innerHTML = this.buildProviderPickerHTML();
      this.wireProviderPicker(pickerEl);
    };

    const addMessage = (role: "user" | "assistant", content: string): { textEl: HTMLElement; row: HTMLElement } => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;${role === "user" ? "justify-content:flex-end" : "justify-content:flex-start"};`;
      const bubble = document.createElement("div");
      bubble.style.cssText = role === "user"
        ? `background:${userBubble};color:#fff;padding:8px 12px;border-radius:12px;max-width:80%;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;`
        : `background:${assistantBubble};border:1px solid ${assistantBorder};padding:8px 12px;border-radius:12px;max-width:80%;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;`;
      const textEl = document.createElement("div");
      textEl.textContent = content;
      bubble.appendChild(textEl);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return { textEl, row };
    };

    const MAX_HISTORY = 20; // Keep last 20 messages to avoid context limits

    const sendMessage = () => {
      const text = inputEl.value.trim();
      if (!text || !this.connection) return;
      inputEl.value = "";
      history.push({ role: "user", content: text });
      // Trim old messages, keeping pairs
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }
      addMessage("user", text);
      const { textEl, row } = addMessage("assistant", "");
      let fullText = "";
      const stream = this.chat({ messages: [...history], context: this.chatContext ?? opts.context, model: modelSwitcher.value || undefined });
      sendBtn.disabled = true; sendBtn.textContent = "...";
      stream
        .on("delta", (delta: unknown) => { fullText += delta as string; textEl.textContent = fullText; messagesEl.scrollTop = messagesEl.scrollHeight; })
        .on("done", (data: unknown) => {
          history.push({ role: "assistant", content: fullText });
          const usage = (data as { usage?: { inputTokens: number; outputTokens: number } }).usage;
          if (usage) {
            const total = usage.inputTokens + usage.outputTokens;
            const tokenEl = document.createElement("div");
            tokenEl.style.cssText = `font-size:10px;color:${textMuted};margin-top:6px;opacity:0.7;`;
            tokenEl.textContent = `${total} tokens (${usage.inputTokens} in / ${usage.outputTokens} out)`;
            // Append to the bubble (parent of textEl)
            textEl.parentElement!.appendChild(tokenEl);
          }
          sendBtn.disabled = false; sendBtn.textContent = "Send";
        })
        .on("error", (err: unknown) => { textEl.textContent = `Error: ${(err as { message: string }).message}`; textEl.style.color = "#e53e3e"; sendBtn.disabled = false; sendBtn.textContent = "Send"; });
    };

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

    this.on("connected", (data: unknown) => {
      const { provider, model } = data as { provider: string; model?: string };
      const info = PROVIDERS.find((p) => p.id === provider);
      statusEl.textContent = info?.name ?? provider;

      // Populate model switcher
      const models = (info as { models?: Array<{ id: string; name: string }> })?.models ?? [];
      modelSwitcher.textContent = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === model) opt.selected = true;
        modelSwitcher.appendChild(opt);
      }

      showChat();
    });
    this.on("disconnected", () => showAuth());
    this.emitIfConnected();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void) { if (!this.destroyed) this.emitter.on(event, cb); }
  off(event: string, cb: (...args: unknown[]) => void) { this.emitter.off(event, cb); }

  chat(request: SDKChatRequestInput): ChatStream & { cancel: () => void } {
    const stream = new ChatStreamImpl();
    if (this.destroyed) {
      setTimeout(() => stream._emit("error", { message: "Instance has been destroyed" }), 0);
      return stream as unknown as ChatStream & { cancel: () => void };
    }
    if (!this.connection) {
      setTimeout(() => stream._emit("error", { message: "No provider connected" }), 0);
      return stream as unknown as ChatStream & { cancel: () => void };
    }
    const provider = this.connection.provider;
    const model = request.model ?? this.connection.model;
    this.track("chat_start", { provider, model });

    // Track chat_complete when done
    const originalOn = stream.on.bind(stream);
    const self = this;
    const wrappedStream = Object.create(stream);
    let completionTracked = false;
    let errorTracked = false;
    wrappedStream.on = function (event: string, cb: (...args: unknown[]) => void) {
      if (event === "done") {
        originalOn(event, (...args: unknown[]) => {
          if (!completionTracked) {
            completionTracked = true;
            const data = args[0] as { usage?: { inputTokens: number; outputTokens: number } } | undefined;
            self.track("chat_complete", {
              provider,
              model,
              tokensIn: data?.usage?.inputTokens,
              tokensOut: data?.usage?.outputTokens,
            });
          }
          cb(...args);
        });
      } else if (event === "error") {
        originalOn(event, (...args: unknown[]) => {
          if (!errorTracked) {
            errorTracked = true;
            const err = args[0] as { message?: string } | undefined;
            self.track("chat_error", {
              provider,
              model,
              error: err?.message?.slice(0, 200),
            });
          }
          cb(...args);
        });
      } else {
        originalOn(event, cb);
      }
      return wrappedStream;
    };

    const effectiveRequest = this.chatContext && !request.context
      ? { ...request, context: this.chatContext }
      : request;
    streamChat(this.connection, effectiveRequest, stream, this.siteId, () => {
      this.disconnect();
    });
    return wrappedStream as unknown as ChatStream & { cancel: () => void };
  }

  getStatus(): SDKConnectionStatusResult {
    if (this.connection) {
      return { connected: true, provider: this.connection.provider, model: this.connection.model };
    }
    return { connected: false };
  }

  setModel(modelId: string) {
    if (this.destroyed || !this.connection) return;
    this.connection.model = modelId;
    saveConnection(this.connection);
  }

  getModels(): Array<{ id: string; name: string }> {
    if (!this.connection) return [];
    const info = PROVIDERS.find((p) => p.id === this.connection!.provider);
    return (info as { models?: Array<{ id: string; name: string }> })?.models ?? [];
  }

  setContext(context: string | undefined) {
    if (this.destroyed) return;
    if (context === undefined) { this.chatContext = undefined; return; }
    if (context.length > 10_000) {
      console.warn("BundleLLM: context exceeds 10,000 characters, truncating");
      context = context.slice(0, 10_000);
    }
    this.chatContext = context;
  }

  disconnect() {
    if (this.destroyed) return;
    const provider = this.connection?.provider;
    this.connection = null;
    clearConnection();
    this.emitter.emit("disconnected");
    this.track("disconnect", { provider });
  }

  destroy() {
    this.destroyed = true;
    this.connection = null;
    this.chatContext = undefined;
    if (this.documentClickHandler) {
      document.removeEventListener("click", this.documentClickHandler);
      this.documentClickHandler = undefined;
    }
    if (this.widgetEl) {
      this.widgetEl.remove();
      this.widgetEl = undefined;
    }
    if (this.signInEl) {
      this.signInEl.remove();
      this.signInEl = undefined;
    }
    this.emitter.removeAll();
  }

  // ---- Internal ----

  private emitIfConnected() {
    if (this.connection) {
      // Defer so external listeners have time to register
      const conn = this.connection;
      setTimeout(() => {
        this.emitter.emit("connected", { provider: conn.provider, model: conn.model });
      }, 0);
    }
  }

  private async validateKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      let res: Response;
      if (provider === "anthropic") {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
      } else if (provider === "openrouter") {
        res = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${key}` },
        });
      } else {
        return { ok: true }; // Unknown provider — skip validation
      }

      if (res.ok || res.status === 429) {
        return { ok: true }; // 429 = rate limited but key is valid
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "Invalid API key" };
      }
      return { ok: false, error: `Validation failed (${res.status})` };
    } catch {
      return { ok: false, error: "Could not validate key. Check your connection." };
    }
  }

  private setConnected(provider: string, key: string, model?: string, viaOAuth = false) {
    this.connection = { provider, key, model };
    saveConnection(this.connection);
    this.emitter.emit("connected", { provider, model });
    this.track(viaOAuth ? "oauth_complete" : "connect", { provider, model });
  }

  private startOAuth(provider: string): Promise<{ ok: boolean; key?: string; error?: string }> {
    this.track("oauth_start", { provider });
    return new Promise((resolve) => {
      const origin = encodeURIComponent(window.location.origin);
      const url = `${this.apiUrl}/api/oauth/${provider}/start?origin=${origin}`;
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const popup = window.open(url, "bundlellm-oauth", `width=${width},height=${height},left=${left},top=${top},popup=yes`);
      if (!popup) { resolve({ ok: false, error: "Popup blocked. Please allow popups." }); return; }

      const expectedOrigin = new URL(this.apiUrl).origin;

      const handleMessage = (event: MessageEvent) => {
        // Validate origin — only accept messages from our OAuth server
        if (event.origin !== expectedOrigin) return;
        if (event.data?.type !== "bundlellm-oauth-result") return;
        window.removeEventListener("message", handleMessage);
        clearInterval(pollTimer);
        if (event.data.success && event.data.key) {
          resolve({ ok: true, key: event.data.key });
        } else {
          resolve({ ok: false, error: "OAuth cancelled" });
        }
      };

      window.addEventListener("message", handleMessage);

      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer);
          window.removeEventListener("message", handleMessage);
          resolve({ ok: false, error: "OAuth window closed" });
        }
      }, 500);

      setTimeout(() => {
        clearInterval(pollTimer);
        window.removeEventListener("message", handleMessage);
        if (!popup.closed) popup.close();
        resolve({ ok: false, error: "OAuth timed out" });
      }, 5 * 60 * 1000);
    });
  }

  private buildProviderPickerHTML(): string {
    return `
      <div style="max-width:320px;margin:0 auto;">
        ${PROVIDERS.map((p) => `
          <button data-bundlellm="provider-btn" data-provider="${p.id}" data-oauth="${p.oauth}" style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px 16px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;margin-bottom:8px;font-family:system-ui,sans-serif;box-sizing:border-box;transition:border-color 0.15s;">
            <div style="text-align:left;">
              <div style="font-size:14px;font-weight:500;color:#1a202c;">${p.name}</div>
              <div style="font-size:12px;color:#718096;">${p.description}</div>
            </div>
            ${p.oauth ? '<span style="font-size:10px;font-weight:600;color:#3182ce;background:#ebf4ff;padding:2px 8px;border-radius:10px;">Sign in</span>' : '<span style="font-size:10px;color:#a0aec0;">API key</span>'}
          </button>
        `).join("")}
        <div data-bundlellm="apikey-form" style="display:none;">
          <button data-bundlellm="back-btn" style="background:none;border:none;color:#718096;font-size:13px;cursor:pointer;margin-bottom:12px;padding:0;font-family:system-ui,sans-serif;">&larr; Back</button>
          <p data-bundlellm="apikey-label" style="font-size:14px;font-weight:500;margin-bottom:4px;"></p>
          <p data-bundlellm="apikey-help" style="font-size:12px;color:#718096;margin-bottom:12px;"></p>
          <select data-bundlellm="model-select" style="width:100%;padding:8px 12px;padding-right:32px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:8px;outline:none;box-sizing:border-box;background:#fff;color:#1a202c;appearance:none;background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23718096%22 stroke-width=%222%22><polyline points=%226 9 12 15 18 9%22/></svg>');background-repeat:no-repeat;background-position:right 10px center;"></select>
          <input data-bundlellm="apikey-input" type="password" style="width:100%;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:8px;outline:none;box-sizing:border-box;">
          <button data-bundlellm="apikey-submit" style="width:100%;padding:10px;background:#3182ce;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:system-ui,sans-serif;">Connect</button>
          <p data-bundlellm="apikey-error" style="display:none;color:#e53e3e;font-size:12px;margin-top:8px;text-align:center;"></p>
          <p style="margin-top:8px;font-size:11px;color:#a0aec0;text-align:center;">Your key stays in your browser. It is never sent to BundleLLM servers.</p>
        </div>
      </div>
    `;
  }

  private wireProviderPicker(container: HTMLElement) {
    const providerBtns = container.querySelectorAll('[data-bundlellm="provider-btn"]');
    const apikeyForm = container.querySelector('[data-bundlellm="apikey-form"]') as HTMLElement;
    const backBtn = container.querySelector('[data-bundlellm="back-btn"]') as HTMLButtonElement;
    const apikeyLabel = container.querySelector('[data-bundlellm="apikey-label"]') as HTMLElement;
    const apikeyHelp = container.querySelector('[data-bundlellm="apikey-help"]') as HTMLElement;
    const apikeyInput = container.querySelector('[data-bundlellm="apikey-input"]') as HTMLInputElement;
    const apikeySubmit = container.querySelector('[data-bundlellm="apikey-submit"]') as HTMLButtonElement;
    const apikeyError = container.querySelector('[data-bundlellm="apikey-error"]') as HTMLElement;
    const modelSelect = container.querySelector('[data-bundlellm="model-select"]') as HTMLSelectElement;

    let selectedProvider = "";

    providerBtns.forEach((btn) => {
      (btn as HTMLElement).addEventListener("mouseenter", () => { (btn as HTMLElement).style.borderColor = "#cbd5e0"; });
      (btn as HTMLElement).addEventListener("mouseleave", () => { (btn as HTMLElement).style.borderColor = "#e2e8f0"; });

      btn.addEventListener("click", async () => {
        const providerId = (btn as HTMLElement).dataset.provider ?? "";
        const isOAuth = (btn as HTMLElement).dataset.oauth === "true";
        const info = PROVIDERS.find((p) => p.id === providerId);
        if (!info) return;

        if (isOAuth) {
          // OAuth flow
          (btn as HTMLButtonElement).disabled = true;
          (btn as HTMLElement).querySelector("span:last-child")!.textContent = "Connecting...";

          const result = await this.startOAuth(providerId);
          // Always reset button state
          (btn as HTMLButtonElement).disabled = false;
          (btn as HTMLElement).querySelector("span:last-child")!.textContent = "Sign in";

          if (result.ok && result.key) {
            this.setConnected(providerId, result.key, undefined, true);
          } else {
            this.track("oauth_error", { provider: providerId, error: result.error?.slice(0, 200) });
            this.emitter.emit("error", { message: result.error ?? "OAuth failed" });
          }
        } else {
          // API key flow
          selectedProvider = providerId;
          apikeyLabel.textContent = `Connect ${info.name}`;
          apikeyHelp.textContent = "Get your API key from ";
          const link = document.createElement("a");
          link.href = (info as { keyUrl?: string }).keyUrl ?? "";
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.style.cssText = "color:#3182ce;";
          link.textContent = info.name;
          apikeyHelp.appendChild(link);
          apikeyInput.placeholder = (info as { placeholder?: string }).placeholder ?? "";
          apikeyInput.value = "";
          apikeyError.style.display = "none";

          // Populate model selector
          const models = (info as { models?: Array<{ id: string; name: string }> }).models ?? [];
          modelSelect.textContent = "";
          for (const m of models) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name;
            modelSelect.appendChild(opt);
          }

          // Hide provider buttons, show API key form
          providerBtns.forEach((b) => ((b as HTMLElement).style.display = "none"));
          apikeyForm.style.display = "block";
        }
      });
    });

    backBtn.addEventListener("click", () => {
      apikeyForm.style.display = "none";
      providerBtns.forEach((b) => ((b as HTMLElement).style.display = "flex"));
    });

    apikeySubmit.addEventListener("click", async () => {
      const key = apikeyInput.value.trim();
      if (!key) { apikeyError.textContent = "API key is required"; apikeyError.style.display = "block"; return; }

      apikeyError.style.display = "none";
      apikeySubmit.disabled = true;
      apikeySubmit.textContent = "Validating...";

      const valid = await this.validateKey(selectedProvider, key);
      if (valid.ok) {
        this.setConnected(selectedProvider, key, modelSelect.value || undefined);
      } else {
        this.track("validation_error", { provider: selectedProvider, error: valid.error?.slice(0, 200) });
        apikeyError.textContent = valid.error ?? "Invalid API key";
        apikeyError.style.display = "block";
        apikeySubmit.disabled = false;
        apikeySubmit.textContent = "Connect";
      }
    });

    apikeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apikeySubmit.click();
    });
  }
}

// ---- Global Entry Point ----

const BundleLLM = {
  init(config?: BundleLLMConfig): BundleLLMInstance {
    return new BundleLLMInstanceImpl(config) as unknown as BundleLLMInstance;
  },
};

export default BundleLLM;

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).BundleLLM = BundleLLM;
}
