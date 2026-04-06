// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import BundleLLM from "../sdk";

beforeEach(() => {
  // Polyfill ReadableStream for jsdom
  if (typeof globalThis.ReadableStream === "undefined") {
    vi.stubGlobal("ReadableStream", NodeReadableStream);
  }
  vi.stubGlobal("crypto", {
    randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 8),
  });
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BundleLLM", () => {
  it("exposes init function", () => {
    expect(typeof BundleLLM.init).toBe("function");
  });

  it("creates an instance with all methods", () => {
    const ai = BundleLLM.init();
    expect(ai.renderSignIn).toBeDefined();
    expect(ai.renderChat).toBeDefined();
    expect(ai.on).toBeDefined();
    expect(ai.off).toBeDefined();
    expect(ai.chat).toBeDefined();
    expect(ai.getStatus).toBeDefined();
    expect(ai.disconnect).toBeDefined();
    expect(ai.destroy).toBeDefined();
    ai.destroy();
  });

  describe("getStatus", () => {
    it("returns not connected by default", () => {
      const ai = BundleLLM.init();
      expect(ai.getStatus().connected).toBe(false);
      ai.destroy();
    });
  });

  describe("renderSignIn", () => {
    it("renders provider picker in target container", () => {
      const container = document.createElement("div");
      container.id = "sign-in";
      document.body.appendChild(container);

      const ai = BundleLLM.init();
      ai.renderSignIn("#sign-in");

      const buttons = container.querySelectorAll('[data-bundlellm="provider-btn"]');
      expect(buttons.length).toBe(2); // OpenRouter, Anthropic

      ai.destroy();
      document.body.removeChild(container);
    });

    it("shows OAuth badge for OpenRouter", () => {
      const container = document.createElement("div");
      container.id = "sign-in";
      document.body.appendChild(container);

      const ai = BundleLLM.init();
      ai.renderSignIn("#sign-in");

      const openrouterBtn = container.querySelector('[data-provider="openrouter"]');
      expect(openrouterBtn?.textContent).toContain("Sign in");

      ai.destroy();
      document.body.removeChild(container);
    });

    it("does nothing if selector not found", () => {
      const ai = BundleLLM.init();
      ai.renderSignIn("#nonexistent");
      ai.destroy();
    });
  });

  describe("renderChat", () => {
    it("creates widget with provider picker and chat area", () => {
      const container = document.createElement("div");
      container.id = "chat";
      container.style.height = "500px";
      document.body.appendChild(container);

      const ai = BundleLLM.init();
      ai.renderChat("#chat");

      expect(container.querySelector('[data-bundlellm="auth"]')).not.toBeNull();
      expect(container.querySelector('[data-bundlellm="chat"]')).not.toBeNull();
      expect(container.querySelector('[data-bundlellm="provider-picker"]')).not.toBeNull();

      ai.destroy();
      document.body.removeChild(container);
    });
  });

  describe("chat", () => {
    it("returns ChatStream", () => {
      const ai = BundleLLM.init();
      const stream = ai.chat({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(stream.on).toBeDefined();
      expect(stream.cancel).toBeDefined();
      ai.destroy();
    });

    it("emits error when not connected", async () => {
      const ai = BundleLLM.init();
      const errors: string[] = [];
      ai.chat({ messages: [{ role: "user", content: "hi" }] })
        .on("error", (err) => errors.push((err as { message: string }).message));

      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toContain("No provider connected");
      ai.destroy();
    });
  });

  describe("disconnect", () => {
    it("clears connection and emits disconnected", () => {
      const ai = BundleLLM.init();
      let disconnected = false;
      ai.on("disconnected", () => { disconnected = true; });
      ai.disconnect();
      expect(disconnected).toBe(true);
      expect(ai.getStatus().connected).toBe(false);
      ai.destroy();
    });
  });

  describe("localStorage persistence", () => {
    it("persists connection across instances", () => {
      // Simulate a stored connection
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
        model: "claude-sonnet-4",
      }));

      const ai = BundleLLM.init();
      const status = ai.getStatus();
      expect(status.connected).toBe(true);
      expect(status.provider).toBe("anthropic");
      ai.destroy();
    });

    it("clears storage on disconnect", () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
      }));

      const ai = BundleLLM.init();
      ai.disconnect();
      expect(localStorage.getItem("bundlellm_connection")).toBeNull();
      ai.destroy();
    });
  });

  describe("chat streaming", () => {
    it("streams OpenAI-compatible response", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      const encoder = new TextEncoder();
      const sseData = [
        'data: {"id":"gen-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"id":"gen-1","choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"id":"gen-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ].join("");

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));

      const ai = BundleLLM.init();
      const deltas: string[] = [];
      let doneData: unknown = null;

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("delta", (text) => deltas.push(text as string))
          .on("done", (data) => { doneData = data; resolve(); })
          .on("error", () => resolve());
      });

      expect(deltas).toEqual(["Hello", " world"]);
      expect(doneData).toEqual({ usage: { inputTokens: 5, outputTokens: 2 } });
      ai.destroy();
    });

    it("streams Anthropic response", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
      }));

      const encoder = new TextEncoder();
      const sseData = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("");

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));

      const ai = BundleLLM.init();
      const deltas: string[] = [];
      let doneData: unknown = null;
      let startData: unknown = null;

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("start", (data) => { startData = data; })
          .on("delta", (text) => deltas.push(text as string))
          .on("done", (data) => { doneData = data; resolve(); })
          .on("error", () => resolve());
      });

      expect(startData).toEqual({ messageId: "msg_1" });
      expect(deltas).toEqual(["Hi"]);
      expect(doneData).toEqual({ usage: { inputTokens: 10, outputTokens: 3 } });
      ai.destroy();
    });

    it("handles HTTP error response", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-bad",
      }));

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: "Invalid API key" } }),
      }));

      const ai = BundleLLM.init();
      let errorMsg = "";

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("error", (err) => { errorMsg = (err as { message: string }).message; resolve(); });
      });

      expect(errorMsg).toContain("Authentication failed");
      expect(errorMsg).toContain("Invalid API key");
      expect(ai.getStatus().connected).toBe(false); // auto-disconnected
      ai.destroy();
    });

    it("handles fetch network error", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

      const ai = BundleLLM.init();
      let errorMsg = "";

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("error", (err) => { errorMsg = (err as { message: string }).message; resolve(); });
      });

      expect(errorMsg).toBe("Network failure");
      ai.destroy();
    });

    it("cancel aborts the stream", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      const abortFn = vi.fn();
      vi.stubGlobal("AbortController", class {
        signal = {};
        abort = abortFn;
      });
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      const ai = BundleLLM.init();
      const stream = ai.chat({ messages: [{ role: "user", content: "hi" }] });
      stream.cancel();
      expect(abortFn).toHaveBeenCalled();
      ai.destroy();
    });
  });

  describe("context injection", () => {
    it("prepends context as system message", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            ));
            c.close();
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const ai = BundleLLM.init();
      await new Promise<void>((resolve) => {
        ai.chat({
          messages: [{ role: "user", content: "hi" }],
          context: "You are helpful.",
        }).on("done", () => resolve()).on("error", () => resolve());
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful." });
      expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
      ai.destroy();
    });
  });

  describe("429 retry", () => {
    it("retries on 429 and succeeds on second attempt", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      const encoder = new TextEncoder();
      const sseData = 'data: {"id":"1","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
      const okBody = new ReadableStream({
        start(c) { c.enqueue(encoder.encode(sseData)); c.close(); },
      });

      let providerCalls = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        // Analytics events — just resolve
        if (url.includes("/api/events")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        // Provider calls
        providerCalls++;
        if (providerCalls === 1) {
          return Promise.resolve({ status: 429, ok: false, headers: new Map(), json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, body: okBody });
      }));

      const ai = BundleLLM.init();
      const deltas: string[] = [];

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("delta", (t) => deltas.push(t as string))
          .on("done", () => resolve())
          .on("error", () => resolve());
      });

      expect(providerCalls).toBe(2);
      expect(deltas).toEqual(["hi"]);
      ai.destroy();
    });

    it("shows rate limit error after max retries", async () => {
      vi.useFakeTimers();

      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        headers: new Map(),
        json: () => Promise.resolve({ error: "Rate limited" }),
      }));

      const ai = BundleLLM.init();
      let errorMsg = "";

      const chatPromise = new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("error", (err) => { errorMsg = (err as { message: string }).message; resolve(); });
      });

      // Fast-forward through retry delays
      await vi.advanceTimersByTimeAsync(15000);

      await chatPromise;

      expect(errorMsg).toContain("Rate limited");
      ai.destroy();
      vi.useRealTimers();
    });
  });

  describe("model selection", () => {
    it("stores model in connection", () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
        model: "claude-haiku-4-5-20251001",
      }));

      const ai = BundleLLM.init();
      const status = ai.getStatus();
      expect(status.connected).toBe(true);
      expect(status.model).toBe("claude-haiku-4-5-20251001");
      ai.destroy();
    });

    it("uses stored model in chat request", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
        model: "openai/gpt-4o-mini",
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            ));
            c.close();
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const ai = BundleLLM.init();
      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("done", () => resolve())
          .on("error", () => resolve());
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("openai/gpt-4o-mini");
      ai.destroy();
    });
  });

  describe("Anthropic streaming in SDK", () => {
    it("sends system as separate field for Anthropic", async () => {
      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
        model: "claude-sonnet-4-20250514",
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
              'data: {"type":"message_stop"}\n\n',
            ));
            c.close();
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const ai = BundleLLM.init();
      await new Promise<void>((resolve) => {
        ai.chat({
          messages: [{ role: "user", content: "hi" }],
          context: "Be helpful.",
        }).on("done", () => resolve()).on("error", () => resolve());
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBe("Be helpful.");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      // Verify Anthropic headers
      expect(mockFetch.mock.calls[0][1].headers["x-api-key"]).toBe("sk-ant-test");
      expect(mockFetch.mock.calls[0][1].headers["anthropic-version"]).toBe("2023-06-01");
      ai.destroy();
    });
  });

  describe("analytics beacons", () => {
    it("sends sdk_load event on init", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        calls.push(url);
        return Promise.resolve({ ok: true });
      }));

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002" });

      // Wait for async deriveSiteId
      await new Promise((r) => setTimeout(r, 50));

      const eventCalls = calls.filter((u) => u.includes("/api/events"));
      expect(eventCalls.length).toBeGreaterThanOrEqual(1);
      ai.destroy();
    });

    it("sends connect event when API key entered", async () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        if (opts?.body) {
          try { bodies.push(JSON.parse(opts.body)); } catch {}
        }
        return Promise.resolve({ ok: true, status: 200 });
      }));

      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "anthropic",
        key: "sk-ant-test",
      }));

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002" });
      await new Promise((r) => setTimeout(r, 50));

      // Should have sdk_load event
      const sdkLoad = bodies.find((b) => b.event === "sdk_load");
      expect(sdkLoad).toBeDefined();
      expect(sdkLoad?.siteId).toBeTruthy();
      ai.destroy();
    });

    it("sends disconnect event", async () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        if (opts?.body) {
          try { bodies.push(JSON.parse(opts.body)); } catch {}
        }
        return Promise.resolve({ ok: true });
      }));

      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
      }));

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002" });
      await new Promise((r) => setTimeout(r, 50));
      ai.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      const disconnect = bodies.find((b) => b.event === "disconnect");
      expect(disconnect).toBeDefined();
      expect(disconnect?.provider).toBe("openrouter");
      ai.destroy();
    });

    it("sends chat_start event", async () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        if (opts?.body) {
          try { bodies.push(JSON.parse(opts.body)); } catch {}
        }
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(
                'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              ));
              c.close();
            },
          }),
        });
      }));

      localStorage.setItem("bundlellm_connection", JSON.stringify({
        provider: "openrouter",
        key: "sk-or-test",
        model: "openai/gpt-4o",
      }));

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002" });
      await new Promise((r) => setTimeout(r, 50));

      await new Promise<void>((resolve) => {
        ai.chat({ messages: [{ role: "user", content: "hi" }] })
          .on("done", () => resolve())
          .on("error", () => resolve());
      });

      await new Promise((r) => setTimeout(r, 50));

      const chatStart = bodies.find((b) => b.event === "chat_start");
      expect(chatStart).toBeDefined();
      expect(chatStart?.provider).toBe("openrouter");
      expect(chatStart?.model).toBe("openai/gpt-4o");
      ai.destroy();
    });

    it("uses provided siteId instead of derived", async () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        if (opts?.body) {
          try { bodies.push(JSON.parse(opts.body)); } catch {}
        }
        return Promise.resolve({ ok: true });
      }));

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002", siteId: "custom_site_id" });
      await new Promise((r) => setTimeout(r, 50));

      const sdkLoad = bodies.find((b) => b.event === "sdk_load");
      expect(sdkLoad?.siteId).toBe("custom_site_id");
      ai.destroy();
    });
  });

  describe("API key validation", () => {
    it("rejects invalid Anthropic key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      }));

      const container = document.createElement("div");
      container.id = "validate-test";
      document.body.appendChild(container);

      const ai = BundleLLM.init({ apiUrl: "http://localhost:3002" });
      ai.renderSignIn("#validate-test");

      // Click Anthropic button
      const anthropicBtn = container.querySelector('[data-provider="anthropic"]') as HTMLButtonElement;
      anthropicBtn?.click();

      await new Promise((r) => setTimeout(r, 50));

      // Fill in key and submit
      const keyInput = container.querySelector('[data-bundlellm="apikey-input"]') as HTMLInputElement;
      const submitBtn = container.querySelector('[data-bundlellm="apikey-submit"]') as HTMLButtonElement;
      if (keyInput && submitBtn) {
        keyInput.value = "sk-ant-invalid";
        submitBtn.click();

        await new Promise((r) => setTimeout(r, 100));

        const errorEl = container.querySelector('[data-bundlellm="apikey-error"]') as HTMLElement;
        expect(errorEl?.style.display).not.toBe("none");
        expect(errorEl?.textContent).toContain("Invalid");
      }

      ai.destroy();
      document.body.removeChild(container);
    });
  });

  describe("destroy", () => {
    it("cleans up without error", () => {
      const ai = BundleLLM.init();
      ai.destroy();
      ai.destroy();
    });
  });
});
