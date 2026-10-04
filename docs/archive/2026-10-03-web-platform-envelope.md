---
type: decision
title: Web platform envelope
description: Coordinates the shell metadata, HTTP door routing, and single-file bundling for browser chrome, crawlers, and LLMs — favicons, manifest, social cards, llms.txt, well-knowns, and preconnects.
status: built
---

# Web platform envelope

The contract is in [component contracts](../component-contracts.md#web-platform-envelope); this record keeps the alternatives and rationale.

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
   - LLMs and AI search engines probe `/llms.txt` and `/llms-full.txt`.
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
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: String shorthand (emoji, raw SVG, path, data URI, URL) or structured `#FaviconItem` list (`rel`, `sizes`, `type`, `href`). Emits `shell/favicon.svg` for vector icons, links `<link rel="icon">` in `shell/index.html`, mounts statics under `/srv`, handles missing icon probes with 204 in Caddy, and inlines icons as data URIs in `bundle.ts`.

### 2. Web App Manifest & Mobile Chrome (Phase 2 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: `meta.manifest` (boolean or `#Manifest` record) and `meta.themeColor`. Emits `shell/manifest.webmanifest` with sensible defaults inferred from app name, description, and favicon. Injects `<link rel="manifest">`, `<meta name="theme-color">`, and mobile Chrome/Safari meta tags into the entry head. In Caddy, routes `/manifest.webmanifest` with `application/manifest+json` typing and redirects `/manifest.json` with 308. In `bundle.ts`, inlines referenced local icons and encodes the manifest JSON into a `data:application/manifest+json;base64,...` URI.

### 3. SEO, Social Cards & OpenGraph (Phase 3 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: `meta.social` (`#Social` record). Synthesizes OpenGraph (`og:type`, `og:title`, `og:description`, `og:image`, `og:url`) and Twitter Card (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:site`, `twitter:creator`) meta tags. Resolves local preview images into cluster statics (`/srv/...`) and generates `<link rel="canonical">` when `url` is configured.

### 4. Crawler & LLM Discovery (Phase 4 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: `meta.llms` (`#Llms` record). Generates `/llms.txt` and `/llms-full.txt` from inline text or references to workspace files. Registers them as cluster statics under `/srv/` and configures Caddy handlers with `Content-Type: text/markdown; charset=utf-8` without template evaluation.

### 5. Platform Well-Knowns (Phase 5 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: `meta.wellKnown` (`[string]: #WellKnownItem` dictionary). Emits files under `.well-known/*` and mounts them as cluster statics (`/srv/.well-known/*`). Caddy serves extensionless files under `/.well-known/*` with `Content-Type: application/json` (meeting Apple Universal Links requirements).

### 6. Early Resource Hints (Phase 6 — Built)
- **Reference**: Moved to [`component-contracts.md#web-platform-envelope`](../component-contracts.md#web-platform-envelope).
- **Summary**: `meta.preconnect` and `meta.dnsPrefetch`. Injects `<link rel="dns-prefetch">` and `<link rel="preconnect">` (with optional `crossorigin`) into document `<head>`. Guaranteed to sort ahead of favicons, manifests, and social tags for optimal network handshake concurrency.

## Alternatives considered

- **Requiring explicit `#FaviconItem` objects**: Forcing `{href: "/favicon.ico", rel: "icon", type: "image/x-icon"}` everywhere eliminates string heuristic guessing, but increases authoring friction for the most common case (`favicon: "🚀"` or `favicon: "favicon.ico"`). Pronto adopts string shorthand for single-value intent while providing `#FaviconItem` for multi-size, multi-rel sets.
- **Requiring pre-rendered binary icon files**: Requiring an external `.png` or `.ico` asset prevents running an app without image authoring tools. Synthesizing an inline vector SVG from an emoji glyph gives prototype and internal apps an immediate visual tab identity with zero build tooling overhead.
- **Relative vs root `start_url` and `scope`**: Defaulting to `"./"` resolves to `/shell/` because the entry template sets `<base href="/shell/">`. Since all application routes live under `/`, this would trap PWAs inside `/shell/` and trigger browser chrome on every user interaction. Pronto defaults `start_url` and `scope` to `"/"` and normalizes relative paths during standalone HTML bundling.
- **Permitting local social images without a canonical origin**: Social card crawlers (Twitterbot, Facebook External Hit) refuse relative `og:image` paths. Pronto rejects local `social.image` at compile time when `social.url` is omitted, eliminating silent preview failures.
- **Server templating on LLM discovery files**: While `robots.txt` and `sitemap.xml` require origin interpolation, running Caddy `templates` over author-supplied `llms.txt` or `llms-full.txt` would execute embedded mustache/Jinja/Go template expressions in documentation and expose server environment secrets. Pronto serves them with pure markdown typing without template execution.
- **Extensionless well-known matching**: A simple `not path *.*` matcher fails on `/.well-known/apple-app-site-association` because the parent folder name contains a dot. Pronto matches the terminal path segment (`^/\.well-known/[^/.]+$`) so extensionless files receive `application/json` while explicit extensions (like `security.txt`) retain their native MIME types.

## Delivery order

| Phase | Slice | Status | Gate |
| --- | --- | --- | --- |
| 1 | Favicon & app icons | **Built** | `favicon_test.ts`, Caddy probes, bundle inlining |
| 2 | Web App Manifest & mobile chrome | **Built** | `envelope_test.ts`, Caddy routing, bundle inlining |
| 3 | SEO, Social Cards & OpenGraph | **Built** | `envelope_test.ts`, canonical and preview statics |
| 4 | LLM discovery (`llms.txt`) & crawlers | **Built** | `envelope_test.ts`, Caddy markdown typing |
| 5 | Platform well-knowns (`/.well-known/*`) | **Built** | `envelope_test.ts`, Caddy extensionless JSON headers |
| 6 | Resource hints (`preconnect`) | **Built** | `envelope_test.ts`, head ordering verification |
