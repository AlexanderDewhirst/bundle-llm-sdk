# BundleLLM SDK — Project Conventions

## Overview

Browser-side JavaScript SDK that lets website owners add AI chat. Users bring their own LLM provider (OpenRouter OAuth or Anthropic API key). The SDK calls provider APIs directly — no proxy.

## Tech Stack

- **TypeScript**, **Vite** (IIFE build), **Vitest** (vmThreads pool, jsdom@24)
- Zero runtime dependencies
- Output: single file `dist-sdk/sdk.js` (21KB / 6.6KB gzip)

## Build & Test

```bash
npm install
npm run build        # Build SDK → dist-sdk/sdk.js
npm run compile      # TypeScript type check
npm test             # 30 tests
```

## Manual Testing

```bash
# Start the API (local or use production)
cd ../bundle-llm-api && docker compose up -d

# Serve the demo page
python3 -m http.server 4444
# Open http://localhost:4444/test/sdk-demo.html
```

The demo page at `test/sdk-demo.html` has two columns: Drop-in Widget and Custom UI. It currently points at the production API (`api.bundlellm.com`).

## Key Files

| File | Description |
|------|-------------|
| `src/sdk/sdk.ts` | Entire SDK (~930 lines) |
| `src/sdk/types.ts` | Public TypeScript types |
| `src/sdk/__tests__/sdk.test.ts` | All tests |
| `test/sdk-demo.html` | Two-column demo page |
| `vite.sdk.config.ts` | IIFE build config |
| `vitest.config.ts` | Test config (vmThreads pool) |

## SDK Architecture

- `PROVIDERS` array defines OpenRouter (OAuth, 6 models) and Anthropic (API key, 3 models)
- `deriveSiteId()` generates SHA-256 of `window.location.origin` for analytics
- `sendEvent()` fires analytics beacons (fire-and-forget) to the API
- `streamChat()` handles SSE streaming for both OpenAI-compatible (OpenRouter) and Anthropic formats
- `BundleLLMInstanceImpl` class exposes all public methods
- `buildProviderPickerHTML()` / `wireProviderPicker()` render the sign-in UI
- Keys stored in `localStorage`, validated against provider API before saving

## Deployment

- **CDN**: manually upload `dist-sdk/sdk.js` to Cloudflare R2 bucket `bundlellm-cdn` → served at `cdn.bundlellm.com/sdk.js`
- **npm**: `npm publish` (requires 2FA)
- **GitHub**: public repo, MIT license

## Conventions

- No runtime dependencies — everything is self-contained in the IIFE bundle
- All dynamic content uses DOM methods (no innerHTML with user data)
- API keys never leave the browser or get emitted in events
- Test with `jsdom@24` (not v29+ due to ESM/top-level-await issues)
