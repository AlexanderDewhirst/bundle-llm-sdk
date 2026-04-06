/**
 * Public types for the BundleLLM SDK.
 */

export interface BundleLLMConfig {
  /** OAuth redirect handler URL (default: https://api.bundlellm.com) */
  apiUrl?: string;
  /** Site identifier for analytics */
  siteId?: string;
}

export interface RenderChatOptions {
  placeholder?: string;
  context?: string;
  welcomeMessage?: string;
  theme?: "light" | "dark";
}

export interface BundleLLMInstance {
  renderSignIn(selector: string): void;
  renderChat(selector: string, options?: RenderChatOptions): void;
  on(event: "connected", cb: (data: { provider: string; model?: string }) => void): void;
  on(event: "disconnected", cb: () => void): void;
  on(event: "error", cb: (err: { message: string }) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  chat(request: SDKChatRequestInput): ChatStream;
  getStatus(): SDKConnectionStatusResult;
  setModel(modelId: string): void;
  getModels(): Array<{ id: string; name: string }>;
  /**
   * Update the system prompt context dynamically. Pass `undefined` to clear.
   *
   * For `renderChat`: overrides the initial `options.context`. For direct
   * `chat()` calls: used as fallback when `request.context` is not provided.
   * Truncated to 10,000 characters if exceeded.
   */
  setContext(context: string | undefined): void;
  disconnect(): void;
  destroy(): void;
}

export interface SDKChatRequestInput {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  context?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface SDKConnectionStatusResult {
  connected: boolean;
  provider?: string;
  model?: string;
}

export interface ChatStream {
  on(event: "start", cb: (data: { messageId: string }) => void): ChatStream;
  on(event: "delta", cb: (text: string) => void): ChatStream;
  on(
    event: "done",
    cb: (data: { usage?: { inputTokens: number; outputTokens: number } }) => void,
  ): ChatStream;
  on(event: "error", cb: (err: { message: string }) => void): ChatStream;
  cancel(): void;
}
