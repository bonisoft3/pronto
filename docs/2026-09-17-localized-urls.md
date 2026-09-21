# Localized URLs

The ground: [`2026-09-09-i18n-is-a-contract.md`](2026-09-09-i18n-is-a-contract.md)
(the message catalogue, `check-i18n`, and why a locale is a contract rather than a
preference), [`2026-08-02-terminal-planes.md`](2026-08-02-terminal-planes.md)
(what the terminal serves and what the cluster's proxy serves), and
[`../../omnishell/interpreter/shell.js`](../../omnishell/interpreter/shell.js)
(`matchRoute`, `currentRoute`), whose router is the thing this changes.

The claim: **a locale is part of the URL's path, not a preference the page
discovers after loading. `/es/reglas` names one document in one language, so it
can be linked, shared, crawled and cached as itself. The language tag is BCP 47
(`pt-BR` is not `pt`), the segment after it is a translated slug drawn from the
same catalogue every other string comes from, and the served artifact is real
HTML for that language — prerendered, not assembled by script after a blank
first paint.**

## Facts not to re-derive

Read out of this tree on 2026-09-17.

- **The router is hash-based and single-pattern.** `shell.js:280` `matchRoute`
  splits `pattern` and `path` on `/` and compares segments literally, `:name`
  capturing one segment each; `currentRoute` reads `location.hash.slice(1)` and
  returns the first route whose single `path` matches. A route has exactly one
  pattern, and the server never sees it — everything after `#` stays in the
  browser.
- **The proxy serves files, not an app.** `apps/*/docker/Caddyfile`'s last block
  is `handle { root * /srv; file_server }`. A request for `/es/reglas` finds no
  such file and 404s. Real paths need either a `try_files` fallback to one
  document or a file at that path — and the second is what makes them
  crawlable.
- **A server-side renderer already exists, and is already exercised per locale.**
  `interpreter/storybook.js` exports
  `renderStorybook(mount, appBase, route, params, units, opts)`, which renders a
  route to DOM under linkedom with no browser. `check-i18n.ts:202` calls it once
  per route × state × locale on every `test`. Prerendering is therefore a new
  *caller* of machinery this repo maintains and tests, not a new engine.
- **`#I18n` carries no more than a list.** `plugins/pronto/schema.cue:901` is
  `{default: string, locales: [...string]}`. There is nowhere to say that `pt-BR`
  and `pt` differ, nowhere to give a locale a path segment, and nowhere for a
  route to hold more than one pattern.
- **Links are written by hand against one spelling.** `arena.cue` carries
  `href="#/regras"` literally. Any scheme that leaves those untouched sends a
  Spanish reader to the Portuguese document.

---

## What a locale is

**One BCP 47 tag, and nothing beside it.** `pt-BR`, `pt-PT`, `es-419`, `en`.

`pt` and `pt-BR` are different locales under this, not spellings of one. A truco
table says *"Sos mano"* to an Argentine and *"Você é mão"* to a Brazilian, and
the catalogue that decides which is chosen by the tag, so the tag has to be able
to tell them apart.

```cue
#I18n: {
    // The locale served unprefixed, and the one x-default names. Must be a key
    // of `locales`: a default naming a locale the app does not carry is a root
    // that resolves to nothing.
    default: string
    locales: [Tag=string]: {
        // The URL segment, lowercased: pt-BR -> pt-br. Emitted for every
        // locale INCLUDING the default, whose segment addresses no document
        // and exists to be redirected away from.
        path: string
    }
}
```

For truco: `default: "pt-BR"`, with `pt-BR`, `es` and `en` declared.

The tag is the key, so there is nowhere to write a second, disagreeing name for
the same locale. `path` is the one derived field kept explicit, because a URL
segment is lowercase by convention and a language tag is not, and because a
region with a single language may want the bare country (`/br/`) without
claiming its language is region-neutral.

Measured against the runtime the terminal already uses, on 2026-09-17:

| tag | `Intl.Locale().language` | `.region` |
|---|---|---|
| `pt-BR` | `pt` | `BR` |
| `es-419` | `es` | `419` |
| `zh-Hant-TW` | `zh` | `TW` |
| `en` | `en` | *(none)* |

Three consequences, and they are why this is a tag rather than a pair of fields:

- **Language and region are already IN the tag.** A separate country field would
  restate `BR`, and two fields that must agree are two fields that can disagree:
  `{language: "pt-BR", country: "PT"}` is writable and means nothing.
- **A separate country field is strictly weaker.** `es-419` names Latin America
  through UN M.49; ISO 3166-1 alpha-2 has no code for it. The tag can say things
  the pair cannot.
- **A malformed tag is refused, not absorbed.** `Intl.getCanonicalLocales` throws
  `RangeError` on `pt_BR` and `ptbr`. The emitter can therefore *check* every
  declared locale rather than trust it, which is the difference between a
  vocabulary and a convention.

`google.com`'s `hl` and `gl` were the obvious prior art and are the wrong import.
They predate BCP 47's regional subtags in common use, and they exist to serve a
case this does not have — searching *in* one language *from* another country,
where interface language and market genuinely diverge. When that case arrives
here (currency, tax, legal copy), it is a **market**, not a locale, and it gets
its own field with its own reason. Folding it in now buys nothing and makes the
disagreeing pair writable from day one.

## Which routes are localized

Two opt-ins, per route, because they answer different questions and the corpus
does not want them together everywhere:

```cue
routes: rules:   {screen: "regras", slug: "route_rules", prerender: true}
routes: article: {screen: "article", slug: "route_article"}  // localized, not prerendered
routes: arena:   {screen: "arena"}                            // neither
```

- **`slug`** makes the route *addressable* in each locale. Works for a route
  carrying `:params`, because a path pattern is translated, not its contents.
- **`prerender`** makes it *crawlable*, by writing a document per locale at
  build. Only possible where the route takes no params: the rows a
  `/article/:slug` would need do not exist when the build runs. Enumerating
  them from data is a different feature and is not this one.

Counted across the ten apps in this repo on 2026-09-17: **79 routes, 56 static
and 23 carrying `:params`.** The split is not between apps but inside them —
`shadcnui` is 33 routes of documentation, `thenote` is `/note/:id` and
`/label/:name` and would be harmed by indexing, `truco` has exactly one page of
content beside a game in progress, and `realworld`'s `/article/:slug` is content
*and* parameterized, which is the row that forces the two opt-ins apart.

That distribution is also the answer to whether this is worth building. As a
whole-app switch it is not: `thenote` would carry machinery that must never run.
Per route it plainly is: `shadcnui` gets 33 documents × every locale for one
field each, and `truco` pays for one page. What does not scale down is the move
off the hash — that is paid once, globally, however few routes opt in.

## Where a locale comes from

Four sources, and the order is conditioned on the route rather than flat,
because a content route has an address for the locale and an app route does not.

| source | who owns it | shareable | crawlable |
|---|---|---|---|
| `/es/reglas` | the publisher | yes | yes |
| `?lang=es` | whoever sent the link | yes | no |
| `Accept-Language` | the reader's system | no | no |
| `#I18n.default` | the app | — | — |

```
a localized route:    the path, and only the path
a plain route:        ?lang=  >  the row  >  Accept-Language  >  default
```

`?lang=` on a *localized* route answers `301` to that locale's path rather than
rendering. Otherwise `/es/reglas?lang=en` is a second address for one document,
which is the duplication the prefix exists to prevent.

The ordering follows from what each source *is*. `Accept-Language` is a standing
need, declared once to a browser and true of every site; it must beat an app's
default and must never override a choice made in this app or a link someone was
handed. Present intent outranks a standing preference — which is the opposite of
how `prefers-reduced-motion` should be treated, and the reason this ordering has
to be written down rather than assumed from the other one.

This demotes, rather than retires, the row-driven switching in `screen.js:2869`.
Its guard is already `!params.locale`; it simply gains rungs above it. A plain
route still follows `match.locale` live, which is what a language picker inside
an app should do. A localized route does not, because its address already said.

**`lang` on the wire, `locale` in the model.** The query parameter is `?lang=`,
which is the popular spelling and the one HTML already uses for a BCP 47 tag
(`<html lang="pt-BR">`, `hreflang="pt-BR"`). Everything inside keeps the name it
has — `params.locale`, `row.locale`, `opts.locale`, `#I18n` — and the router
translates once, at the boundary. One wire name, one model name, one place they
meet; renaming the model instead would reach every app's `match.locale` column.

Note that `?lang=` does not work today. `matchRoute` folds query parameters in
under their literal names, so `?lang=es` currently arrives as `params.lang`,
which nothing reads.

**One resolver, not four.** The order above lives in a single exported function
that the router, the prerenderer and the storybook all call. Four sources
re-derived at three call sites is how a row and a path come to disagree about
what language a screen is in, and `check-i18n` should assert the order rather
than each caller reimplementing it.

## What a URL is

```
/regras                /es/reglas          /en/rules
└ slug ┘               └locale┘└ slug ┘
   ^ the default locale, unprefixed
```

**The default locale wears no prefix.** For truco that is `pt-BR`, so the
Brazilian reader — who is most of them — gets `/regras`, and every other locale
is prefixed. `#I18n.default` names which one that is.

The obvious objection is that this gives one document two addresses, `/regras`
and `/pt-br/regras`, which is the kind of duplication a canonical tag exists to
paper over. It does not, because the prefixed form of the default is **not
served**: it answers `301` to the unprefixed one. One document, one address, and
a reader who guesses the symmetrical spelling still arrives.

That redirect is what makes the asymmetry safe rather than merely convenient.
Without it the two URLs both render, both get indexed, and the canonical tag
becomes the only thing standing between the app and split ranking — a tag being
load-bearing where a redirect would have been decisive.

The alternative — prefixing every locale including the default — is uniform in
the router and worse everywhere else: it spends a redirect on every bare-root
visit from the primary market, and it makes the common URL the long one. The
cost of the asymmetry is one branch in `currentRoute` and one redirect rule; the
cost of the symmetry is paid by every reader in the default language.

A route's slug becomes a message key, like every other string:

```cue
routes: rules: {
    screen: "regras"
    slug:   "route_rules"     // catalogues carry: regras / reglas / rules
}
```

This is the whole reason to spell it as a key rather than a per-route map of
locale → segment: **the slug lands in the same catalogue a translator already
works in**, and `check-i18n` refuses a locale missing a key without learning
anything new. A route whose slug is absent in Spanish is the same finding as a
button whose label is.

Two constraints the emitter must enforce, both decidable:

1. **No two routes may share a slug within a locale.** `/es/reglas` must name one
   screen. This is a `cue vet` over the emitted set, not a runtime check.
2. **A slug is URL-safe**: lowercase, unreserved characters, no percent-encoding.
   Accents are transliterated by the author in the catalogue, not by the
   emitter — `regras` not `régras` — because a machine guessing at
   transliteration gets Turkish dotted i wrong and nobody notices for a year.

## What the router does

`matchRoute` stays exactly as it is. `currentRoute` grows one step: read the
first segment, and take it as a locale only if it names one — otherwise the path
is already in the default language and every segment is slug.

```js
const [, first, ...rest] = path.split("/");
// A segment naming a locale is a prefix; anything else is the default's own
// first slug segment. `byPath` is emitted, so this asks a map rather than
// guessing from the shape of the word.
const prefixed = Object.hasOwn(cfg.i18n.byPath, first);
const locale = prefixed ? cfg.i18n.byPath[first] : cfg.i18n.default;
const rel = prefixed ? "/" + rest.join("/") : path;
for (const r of cfg.routes) {
  const params = matchRoute(slugOf(r, locale), rel);
  if (params) return { route: r, params, locale };
}
```

The ambiguity this invites is real and is settled by construction: a *default*
slug may never equal a locale's path segment, or `/es` would be both "the
Spanish home" and "the route whose Portuguese slug is `es`". That is one more
decidable emitter constraint beside the two above, and it is why `byPath` is a
map the emitter writes rather than a pattern the router infers.

The locale arrives as data on the route match rather than being discovered later
by the screen, which is what lets the first render be correct instead of
corrected. `params.locale` already feeds the catalogue
(`screen.js`'s `activeLocale`), so nothing downstream changes.

A route with no `slug` never reaches this: it is matched as it is today, and its
locale comes from the resolver's lower rungs — `?lang=`, then the row, then the
header. Both paths end by putting one value in `params.locale`, which is what
keeps the rest of the terminal ignorant of where it came from.

**The hash goes.** `location.hash.slice(1)` becomes `location.pathname`, and
navigation becomes `history.pushState`. This is the part that cannot be done
halfway: a hash is invisible to the server, so no amount of prerendering makes
`#/reglas` a crawlable document.

## What the links do

Every `href` naming a route resolves through the same locale the page is in.
`href="#/regras"` written by hand is the failure mode, so the vocabulary should
make the hand-written form impossible rather than lint for it:

```html
<a data-route="rules">Regras</a>
```

The binder writes `href="/es/reglas"` at render, from the route table and the
active locale. An author who writes a literal `href` to an internal path is
refused by `check-markup`, the way a literal colour is refused by the design
lint. This also gives the language switcher its one honest implementation: the
*same* route, resolved under a different locale, which is a link rather than a
state change.

## What the server serves

Two layers, and the SEO claim rests entirely on the second.

**Fallback (correctness).** The Caddyfile's last block gains a `try_files`, so a
deep link renders even where nothing is prerendered, and the default locale's
prefixed spelling is answered with a permanent redirect rather than a document:

```caddyfile
# The default locale is unprefixed; its prefix is an alias, not an address.
# handle_path strips the matched prefix before its body runs, so {path} is
# what remains — /pt-br/regras -> /regras, /pt-br -> /.
handle_path /pt-br/* {
  redir {path} permanent
}
redir /pt-br / permanent

handle {
  root * /srv
  try_files {path} {path}/index.html /index.html
  file_server
}
```

Exercised against caddy 2.10.0 on 2026-09-17, because `caddy validate` accepts
more than it serves: the first spelling of this used a `redir` with a path
placeholder, adapted cleanly, and answered `301` with an **empty** `Location`.
A config that parses is not a config that redirects.

**Prerender (discoverability).** At build, for every route × locale, call
`renderStorybook` — the same function `check-i18n` already runs for every route
× state × locale — and write the result to `/srv/<prefix><slug>/index.html`,
where `<prefix>` is empty for the default locale and `<locale.path>/` for every
other. `try_files` then finds a real document and never reaches the fallback.

What that buys, and why it is worth the build step:

- A crawler receives complete HTML in the right language on the first response,
  with no script execution. The alternative — a blank shell that assembles
  itself — is the single most common reason an SPA ranks badly.
- The document carries `<html lang="es">`, its own `<title>` and
  `<meta name="description">` from the catalogue, a `<link rel="canonical">` to
  its own URL, and a complete `hreflang` set naming every sibling locale. These
  are *derivable* from the route table and the catalogue, which means they can
  be emitted rather than remembered.
- **`x-default` points at the default locale's unprefixed URL**, which is the
  one claim the asymmetry obliges the emitter to get right: it is what a crawler
  is told to serve a reader whose language matches none of the alternates.
- The prerendered document is a cache entry the CDN can hold per locale.

It is a build-time render of a screen whose data is not yet known, so what it
contains is the screen's empty state — which is what a crawler should index
anyway, and exactly what `renderStorybook` is built to produce.

## What this does not do

- **It does not translate content.** A row a person wrote stays in the language
  they wrote it in; see
  [`../../../libraries/mecha/docs/2026-09-09-multilingual-data-paths.md`](../../../libraries/mecha/docs/2026-09-09-multilingual-data-paths.md),
  whose retry and staleness defects are unresolved and which is deliberately not
  a dependency of this.

  It does, however, **correct that design's trigger**. It synthesizes demand from
  `Accept-Language`, which this contradicts: a reader who asked for `/es/reglas`
  gets Spanish whatever their browser says. Demand must key off the resolver's
  answer — the path where there is one, the header only where there is not —
  or the page renders Spanish while the backend queues Portuguese for a reader
  whose browser happens to prefer it.

  A second consequence worth stating before it surprises someone: translated
  *content* is never in a prerendered document, because prerendering runs at
  build and translation at read. Crawlers index the shell in each language and
  not the rows. For truco that is correct; for a content app it is a limit
  somebody will eventually want lifted, and lifting it means rendering at
  request time, not at build.
- **It does not negotiate where anything explicit was said.** `Accept-Language`
  decides the bare `/` and the plain routes that carry no `?lang=` and no row —
  and nothing else. A bare `/` answers `302`, never `301`, since the right
  locale differs per reader and a permanent redirect would be cached across all
  of them. A crawler sends no `Accept-Language`, so it receives the default at
  `/`, which is what `x-default` names.
- **It does not model a market.** Currency, tax and legal copy follow the country
  someone is *in*, which a language tag does not claim to know. That is a
  separate field when something needs it, and the URL shape does not change when
  it arrives.

## The alternatives, and why not

- **The query parameter alone, for every route.** Simplest, and it is what
  `google.com` itself serves. But a query string is a weaker canonical signal
  than a path, caches fragment on it badly, and it reads as a setting rather
  than as an address. A search engine's own URLs are tuned for a search engine's
  problem, which is not this one. It stays as the *plain* route's mechanism,
  where there is no document to address and nothing to index.
- **Locale on a subdomain (`es.truco.app`).** Strongest separation, and correct
  where the content genuinely differs per market. It costs a certificate and a
  DNS record per locale and makes local development materially worse, which is
  not a trade an app with three locales should make.
- **Keep the hash, prerender nothing.** Cheapest by far, and it keeps the router
  untouched. It also forfeits the entire stated goal: `#/reglas` is one document
  to every crawler on earth.
- **A per-route map of locale → segment**, rather than a slug key. Avoids
  putting URL text in a message catalogue, which some will find surprising. It
  also creates a second place translators must be sent, and a second thing
  `check-i18n` must learn to check. One catalogue is worth the surprise.
