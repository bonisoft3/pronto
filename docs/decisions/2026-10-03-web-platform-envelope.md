---
type: decision
title: Web platform envelope
description: Coordinates the shell metadata, HTTP door routing, and single-file bundling for browser chrome, crawlers, and LLMs — favicons, manifest, social cards, llms.txt, well-knowns, and preconnects.
status: building
---

# Web platform envelope

An app's inner domain is its state ([entities and pipelines](../component-contracts.md#what-each-part-declares)) and its surface ([screens](../screens.md) and handlers). Between the client runtime and the outside world sits the **web platform envelope**: the metadata, door routing, and discovery documents that browsers, OS shells, crawlers, and LLMs read before or outside screen execution.

An app cannot manage this envelope merely by dropping files into its directory. This record establishes the platform boundaries and rollout order for envelope metadata.

## The three-way impedance match

Three platform constraints govern everything in the envelope:

1. **The entry document is compiled, not authored**:
   [`shell/index.html`](../screens.md#how-a-routes-first-document-is-rendered) is emitted by pronto from omnishell's template. The template owns `<base href="/shell/">` and suppresses unconfigured icons with `<link rel="icon" href="data:,">`. An app has no raw `<head>` to author; every tag must be synthesized from CUE declarations.

2. **The HTTP door routes unsolicited requests**:
   Mecha's [Caddy door](../../../libraries/mecha/docs/proxy.md) answers requests that arrive before any HTML is parsed:
   - Chromium and Safari probe `/favicon.ico` unsolicited when a page declares no icon or for non-HTML responses (e.g. raw assets, API endpoints, 404s); the 204 response prevents network console errors and satisfies Lighthouse Best Practices.
   - iOS queries `/.well-known/apple-app-site-association` without an extension and refuses responses lacking `Content-Type: application/json`.
   - Web crawlers probe `/robots.txt` and `/sitemap.xml`.
   - LLMs and AI search engines probe `/llms.txt`.
   A file present in an app folder is invisible at the door unless declared in `#Cluster.meta.statics` and handled by Caddy's route table.

3. **Standalone distribution has no web server**:
   `sayt release@pages` compiles an app into a single standalone HTML document via [`bundle.ts`](../release-targets.md#pages). In that release target, there is no Caddy door or companion file server: envelope assets must either be inlined (e.g. data URIs for favicons and manifests) or explicitly emitted as companion artifacts.

## The envelope capabilities

```
                           +------------------------+
                           |       #App.meta        |
                           +-----------+------------+
                                       |
                   +-------------------+-------------------+
                   |                   |                   |
                   v                   v                   v
         +-------------------+ +---------------+ +-------------------+
         |  shell/index.html | | Mecha Caddy   | | bundle.ts         |
         |  <head> injection | | /srv & headers| | data URI inlining |
         +-------------------+ +---------------+ +-------------------+
```

### 1. Favicons & App Icons (Phase 1 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope-favicons--app-icons`](../component-contracts.md#web-platform-envelope-favicons--app-icons).
- **Summary**: String shorthand (emoji, raw SVG, path, data URI, URL) or structured `#FaviconItem` list (`rel`, `sizes`, `type`, `href`). Emits `shell/favicon.svg` for vector icons, links `<link rel="icon">` in `shell/index.html`, mounts statics under `/srv`, handles missing icon probes with 204 in Caddy, and inlines icons as data URIs in `bundle.ts`.

### 2. Web App Manifest & Mobile Chrome (Phase 2 — Planned)
- **Problem**: Installing an app as a standalone PWA on mobile and desktop requires a Web App Manifest and mobile viewport metadata.
- **Open trade-offs**: Whether manifest fields should be unified directly into `#App.meta` or grouped under `#App.meta.manifest`; and whether `bundle.ts` should inline the manifest as a `data:` URI or emit a sidecar file alongside standalone `index.html`.

### 3. SEO, Social Cards & OpenGraph (Phase 3 — Planned)
- **Problem**: Link previews on Slack, Discord, Twitter/X, and LinkedIn read OpenGraph (`og:image`, `og:title`) and Twitter Card tags. Scrapers require absolute URLs (`https://domain/preview.png`) and do not execute JavaScript.
- **Open trade-offs**: Resolving absolute canonical URLs when an app does not know its production domain at build time; and whether prerendered routes should inherit root social tags or allow per-screen overrides.

### 4. Crawler & LLM Discovery (Phase 4 — Planned)
- **Problem**: Search engines read `robots.txt` and `sitemap.xml`; AI search engines and LLM agents (ChatGPT, Claude, Perplexity) read `llms.txt` and `llms-full.txt` for curated markdown summaries.
- **Open trade-offs**: Whether `llms.txt` should be authored directly in the app tree or synthesized from doc files and app metadata.

### 5. Platform Well-Knowns (Phase 5 — Planned)
- **Problem**: Passkeys, iOS Universal Links, and Android App Links query fixed paths under `/.well-known/`.
- **Open trade-offs**: Whether to introduce an explicit `#WellKnown` dictionary or configure generic Caddy route rules for extensionless JSON files.

### 6. Early Resource Hints (Phase 6 — Planned)
- **Problem**: External fonts or CDNs require early socket setup before application scripts execute.
- **Open trade-offs**: Balancing preconnect overhead vs latency wins; and ensuring hint tags sort ahead of `{modulepreload}`.

## Alternatives considered

- **Requiring explicit `#FaviconItem` objects**: Forcing `{href: "/favicon.ico", rel: "icon", type: "image/x-icon"}` everywhere eliminates string heuristic guessing, but increases authoring friction for the most common case (`favicon: "🚀"` or `favicon: "favicon.ico"`). Pronto adopts string shorthand for single-value intent while providing `#FaviconItem` for multi-size, multi-rel sets.
- **Requiring pre-rendered binary icon files**: Requiring an external `.png` or `.ico` asset prevents running an app without image authoring tools. Synthesizing an inline vector SVG from an emoji glyph gives prototype and internal apps an immediate visual tab identity with zero build tooling overhead.

## Delivery order

| Phase | Slice | Status | Gate |
| --- | --- | --- | --- |
| 1 | Favicon & app icons | **Built** | `favicon_test.ts`, Caddy probes, bundle inlining |
| 2 | Web App Manifest & mobile chrome | Planned | `manifest.test.ts`, PWA audit, manifest MIME check |
| 3 | SEO, Social Cards & OpenGraph | Planned | `social.test.ts`, canonical resolution |
| 4 | LLM discovery (`llms.txt`) & crawlers | Planned | `crawl.test.ts`, cluster statics admission |
| 5 | Platform well-knowns (`/.well-known/*`) | Planned | Caddy header tests for extensionless JSON |
| 6 | Resource hints (`preconnect`) | Planned | Head ordering lint |
