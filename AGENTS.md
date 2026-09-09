# Trans All Repository Guide

## Project overview

Trans All is a Manifest V3 Chrome/Edge extension for immersive whole-page and selection translation through user-configured LLM providers. The extension has no build step and no runtime package dependencies; source files in this repository are loaded directly by the browser.

## Architecture

- `manifest.json` is the source of truth for permissions, entry points, script load order, and keyboard commands.
- `src/shared/` contains classic scripts shared through `globalThis.TA`. They are intentionally not ES modules because they run through `importScripts`, manifest content-script arrays, and HTML `<script>` tags.
- `src/background/service-worker.js` owns provider network requests, message routing, context menus, shortcuts, and streaming ports.
- `src/content/` owns DOM extraction, placeholder handling, translation rendering/restoration, selection UI, and lazy/dynamic page scheduling.
- `src/popup/` contains page-level controls; `src/options/` contains provider and extension settings.
- `test/` uses Node's built-in test runner and jsdom. `test/helpers/env.js` installs browser API mocks and loads the classic scripts in dependency order.

## Development rules

- Preserve classic-script compatibility: do not add ESM `import`/`export` syntax or assume a bundler.
- When adding a shared script, update every relevant loading surface and preserve dependency order: `manifest.json`, background `importScripts`, and/or extension HTML.
- Keep cross-context message and port names in `TA.MSG`, `TA.STREAM_PORT`, or `TA.BATCH_PORT`; keep payloads structured-clone compatible.
- Treat DOM restoration as an invariant. Translation and error UI must be removable without changing the original page structure or content.
- Preserve inline placeholder semantics: paired `<iN>...</iN>` tags retain translatable inline markup, while self-closing `<xN/>` tags retain non-translatable content. Malformed model output must never leak placeholder text into the page.
- Avoid translating editable controls, excluded subtrees, code blocks, extension-generated nodes, and content already in the target writing system.
- Whole-page translation must remain lazy, batched, concurrency-limited, cancellable, and safe against duplicate rendering or MutationObserver feedback loops.
- Keep provider-specific request formats isolated in `src/shared/providers.js`. Never log, hard-code, sync, or expose API keys; keys belong only in `chrome.storage.local` and requests to the configured provider.
- Account for MV3 service-worker restarts and script reinjection. Do not rely solely on module-local state when the DOM or extension storage is the durable source of truth.
- Update `README.md` when user-visible behavior, configuration, supported providers, commands, permissions, installation, or known limitations change.

## Verification

Run the full automated suite after changes:

```bash
npm test
```

Add or update focused tests alongside behavior changes. In particular:

- DOM extraction and exclusions: `test/dom.test.js`
- language filtering: `test/lang.test.js`
- batching, caching, prompts, and retries: `test/engine.test.js`
- provider request/stream parsing: `test/providers.test.js`
- placeholder safety: `test/placeholder.test.js`
- rendering and exact restoration: `test/render.test.js`
- lazy scheduling, cancellation, reinjection, and dynamic content: `test/page.test.js`

For UI, manifest, permission, content-script injection, or real streaming changes, also load the repository root as an unpacked extension and manually verify the affected flow in Chrome or Edge. Do not include `node_modules/`, `test/`, or `package.json` in a distribution package.

## Style

- Follow the existing JavaScript style: strict mode inside IIFEs, two-space indentation, semicolons, single quotes, and domain-focused comments where browser or model behavior is non-obvious.
- Prefer small changes that respect the existing `TA` namespaces and separation between provider, engine, DOM, render, scheduling, and UI responsibilities.
- User-facing copy is primarily Simplified Chinese; keep terminology consistent with the existing UI and README.
