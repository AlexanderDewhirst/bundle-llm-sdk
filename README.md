# BundleLLM SDK

The easiest way to add AI to your website. Users connect their own LLM provider and your site gets streaming chat. No API costs for you. One script tag.

## Quick Start

### Drop-in Widget (3 lines)

```html
<script src="https://cdn.bundlellm.com/sdk.js"></script>
<div id="chat" style="height:500px;"></div>
<script>
  BundleLLM.init().renderChat('#chat', {
    context: 'This is a product page for...',
    placeholder: 'Ask about this product...',
  });
</script>
```

### Custom UI (full control)

```html
<script src="https://cdn.bundlellm.com/sdk.js"></script>
<script>
  const ai = BundleLLM.init();

  // Provider picker — OAuth for OpenRouter, API key for Anthropic
  ai.renderSignIn('#sign-in');

  ai.on('connected', ({ provider, model }) => {
    // User connected — show your chat UI
  });

  // Stream AI responses
  const stream = ai.chat({
    messages: [{ role: 'user', content: 'Summarize this' }],
    context: 'Your page content here...',
  });

  stream
    .on('delta', (text) => { /* append to your container */ })
    .on('done', ({ usage }) => {
      // usage.inputTokens, usage.outputTokens
    })
    .on('error', (err) => { /* handle */ });

  // Update context dynamically (e.g., when page content changes)
  ai.setContext('Updated page content...');

  // Clear context override to revert to the original
  ai.setContext(undefined);

  // Switch model, disconnect
  ai.setModel('anthropic/claude-haiku-4-5-20251001');
  ai.disconnect();
</script>
```

## How It Works

```
User picks provider → OAuth popup (OpenRouter) or API key + model selector
  → Key validated against provider API
  → Key stored in browser localStorage
  → SDK calls provider API directly
  → Streaming response rendered in site's UI
```

No proxy for chat. No user accounts. No server-side credential storage.

## Supported Providers

| Provider | Auth | Models |
|----------|------|--------|
| OpenRouter | OAuth (one-click) | Claude Sonnet 4, GPT-4o, Gemini 2.5 Pro, Llama 4, 200+ more |
| Anthropic | API key + model selector | Claude Sonnet 4, Haiku 4.5, Opus 4 |

## Features

- **Drop-in widget** — complete chat UI with `renderChat('#chat')`
- **Custom UI** — event-driven API for full control
- **Model selection** — dropdown in widget header + `setModel()` / `getModels()` for custom UI
- **Token usage** — displayed per message so users see their cost
- **Context injection** — site owners pass system prompts with every message
- **Dynamic context** — update context after init with `setContext()` without losing chat history
- **API key validation** — keys verified against provider before connecting
- **Auto-disconnect on auth errors** — expired/revoked keys handled gracefully
- **429 retry** — exponential backoff on rate limits (3 retries)
- **Conversation limit** — history capped at 20 messages to avoid context overflow
- **Clear chat** — users can reset conversation from the widget menu
- **Dark mode** — widget supports `theme: 'dark'`
- **Analytics beacons** — lightweight events for usage tracking

## SDK API

| Method | Description |
|--------|-------------|
| `BundleLLM.init(config?)` | Create instance. Optional `{ apiUrl, siteId }`. |
| `.renderChat(selector, options?)` | Drop-in widget with auth, chat, streaming, token usage, model selector. |
| `.renderSignIn(selector)` | Provider picker — OAuth + API key + model selector. |
| `.chat(request)` | Stream a chat response. Returns `ChatStream`. |
| `.setContext(context?)` | Update the system prompt context dynamically. Pass `undefined` to clear. |
| `.getStatus()` | `{ connected, provider, model }` |
| `.setModel(modelId)` | Change model while connected. |
| `.getModels()` | Available models for connected provider. |
| `.disconnect()` | Clear provider connection. |
| `.on(event, cb)` | Listen for `connected`, `disconnected`, `error`. |
| `.destroy()` | Clean up listeners and state. |

## Security

- **HTTPS recommended** — warns in console on non-HTTPS origins (API keys in localStorage may be exposed)
- **API key validation** — keys tested against provider API before storing
- **postMessage origin validation** — OAuth responses only accepted from API server origin
- **No innerHTML** — all dynamic content uses DOM methods
- **API keys stay in browser** — never sent to BundleLLM servers
- **PKCE OAuth** — authorization codes protected by code verifier/challenge
- **Auto-disconnect on auth errors** — expired/revoked keys trigger sign-out
- **429 retry with backoff** — rate limit responses retried before surfacing

## Site Owner Requirements

Per the [Terms of Service](https://bundlellm.com/terms), custom UI integrations must:

1. Provide a **disconnect button** so users can sign out
2. Display **token usage** so users see their cost per message
3. Show which **provider and model** the user is connected to
4. Not intercept, log, or transmit users' API keys

## Development

```sh
npm install
npm run build        # Build SDK → dist-sdk/sdk.js
npm run compile      # TypeScript type check
npm test             # 36 tests
```

### Test the SDK

```sh
# Start the OAuth API
cd ../bundle-llm-api && docker compose up -d

# Serve the demo page
python3 -m http.server 4444
# Open http://localhost:4444/test/sdk-demo.html
```

## Tech Stack

TypeScript, Vite, Vitest

## License

[MIT](LICENSE)
