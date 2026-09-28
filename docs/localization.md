---
type: concept
title: Localization
description: "How an app's declared locales become catalogues, addresses, door redirects and crawlable documents, where locale-dependent code may run, and how text sorts — each gap a refusal before release, never a fallback that ships."
---

# Localization

An app declares its locales once, in `meta.i18n` (`#I18n` in `schema.cue`),
and the emitter derives the rest: the locale table in `shell.yaml`, each
route's address in every locale, the door's redirects and negotiation in the
Caddyfile, the sitemap's `hreflang` alternates, and the checks that grade them.
A translation that is missing is refused — a `cue vet` error or a `check i18n`
finding — rather than shown in the default language. Formatting belongs to the
terminal; of the modules an app writes, only an adapter holds `Intl`, and a
guarded one. What an author writes is
[the guide's i18n section](../GUIDE.md#i18n); what a screen may say is
omnishell's [REFERENCE](../../omnishell/REFERENCE.md#placeholders).

## Locale tags

The key of `meta.i18n.locales` is one BCP 47 tag, and nothing sits beside it.
`pt` and `pt-BR` are different locales: a truco table says *"Sos mano"* to an
Argentine and *"Você é mão"* to a Brazilian, and the tag is what chooses the
catalogue. The tag already carries language and region (`Intl.Locale("pt-BR")`
is `pt` + `BR`), so a separate country field would be a second statement that
can disagree with the first, and a weaker one: `es-419` names Latin America
through UN M.49, which ISO 3166-1 has no code for. `path` is the one derived
field kept explicit, because a URL segment is lowercase and a tag is not, and
because a country may want its bare code (`/ar/`) without claiming its language
is region-neutral. A malformed tag is refused, not absorbed: the schema's
pattern refuses `pt_BR`, and `check i18n` asks `Intl.getCanonicalLocales` about
every declared tag.

A market (currency, tax, legal copy, the way Google's `gl` differs from its
`hl`) or a content variant (truco's rules per country) is not a locale. It is
the app's own column, which a locale's region may default.

## Catalogues

A catalogue is standard JSON, `messages/<tag>.json`, embedded by the app
package and handed to `meta.i18n.catalogues`, so translators and translation
management systems read it without a converter. A value is one sentence or a
flat map of arms that `data-msg-plural` (the CLDR category of a count column)
or `data-msg-select` (a column's own value) picks from.

Completeness is refused at two points. A `slug` or `label` key is resolved by
the emitter, so a locale missing one is a reference error at `cue vet`, and a
slug that resolves to a map, or to text that is not a URL segment, fails the
same way. Every other key is found by `check i18n` (omnishell's
`check-i18n.ts`, at `test` wherever catalogues are declared), which renders
every route and storyboard state under every declared locale. A missing key
falls back to the default catalogue, so it finds:

- a sentence in the default language where another was due;
- a screen that renders identically in two locales;
- an un-interpolated `{msg.…}`;
- a map of arms missing an arm;
- a chrome key (`chrome_signin`, `chrome_signout`, a nav label) the terminal
  would otherwise speak in English.

A pseudo-locale pass (`en-XA`, `ar-XB`) then renders under a decorated
catalogue total over every key and arm, and reports prose that reached no
catalogue.

## Addresses

A route opts in to a translated address with `slug`, a message key for its
first segment. The segments after it, `:params` included, are carried verbatim,
because a pattern is translated and its contents are not. The slug is a message
key rather than a per-route map of locale to segment, so it lands in the file a
translator already works in, and a Spanish route missing its slug is the same
finding as a Spanish button missing its label. The author transliterates
accents in the catalogue; a machine guessing at transliteration gets Turkish
dotted i wrong.

**The default locale is served unprefixed.** For truco that is `pt-BR`, so most
readers get `/regras`. Its prefixed spelling, `/pt-br/regras`, is not a second
copy: the door answers it with 301 and keeps the query.

**The door negotiates only the unprefixed addresses.** A request for a
default-locale address whose `Accept-Language` names another declared locale
gets a 302 to that locale's address, unless it carries `?lang=`. A prefixed
address is never negotiated. The door's matcher is the terminal's rule compiled
into one regex (first declared tag, exact before bare language), so the
declaration order of `locales` decides which country a bare `es` reaches; `negotiation_test.ts` reads the emitted Caddyfile back and
refuses a disagreement with `negotiateLocale`. A crawler sends no
`Accept-Language`, so it gets the default, which is what `x-default` names.

**Collisions are errors at emission, not 404s.** Within a locale no two routes
may share a pattern, and no default-locale pattern may equal a locale's prefix,
or `/es` would be both the Spanish home and the route whose Portuguese slug is
`es`. `emit.cue` refuses both over every route, slugged or not.

**A link names a route, never a path.** `data-route` and `data-param-*` let the
terminal compose the address in the page's locale, so the same markup addresses
`/regras` and `/ar/reglas`, and a language switcher is the same link with
`data-locale`. A hand-written `href="/regras"` would send an Argentine reader
to the Portuguese document. The router reads `location.pathname`: a hash is
invisible to the server, so no prerendering could make `#/reglas` a document.

**The terminal resolves a page's locale** in the order omnishell's
[reference](../../omnishell/REFERENCE.md#placeholders) gives, and the
prerenderer and the storybook are handed the locale they render. The order puts
present intent above a standing preference: `Accept-Language` is declared once
to a browser for every site, so it beats an app's default and never overrides a
choice made in the app or a link someone was handed.

## Crawlable documents

`prerender: true`, allowed only on a route with no `:param`, renders one
document per locale carrying `lang`, `dir`, a canonical link, `hreflang`
siblings and `x-default`. Only a param-less route can be one, because the rows
an `/article/:slug` needs do not exist at build. The choice is per route since
the split falls inside apps: shadcnui's documentation routes are content,
thenote's `/note/:id` would be harmed by indexing, and realworld's
`/article/:slug` is content and parameterized. What the `prerender` check
grades, and that nothing ships the documents, is
[screens](screens.md#how-a-routes-first-document-is-rendered). A public app's
`sitemap.xml` lists every route without a `:param` once per locale, each entry carrying the
whole alternate set and `x-default`, so a crawler reaching one spelling learns
the others and reads them as one page rather than near-duplicates.

## Where locale-dependent code runs

A Jessie module can run in three runtimes with three ideas of a locale: a
browser compartment, the Deno cage the checkers use, and, for a validation,
plv8 inside the write. A bare SES compartment has no `Intl`, and its tamed
`toLocaleString` lies (`(1234.5).toLocaleString("pt-BR")` is `"1234.5"`).
plv8 in the database image ships no ICU, and PGlite cannot host plv8 at all, so
in the browser the store's predicate is the only one.

So `Intl` is the interpreter's. The terminal formats (`datetime`, `number`,
`money`) and picks plural arms, because a formatter's output is text for one
reader's pixels, and that reader's own ICU is the authority on how their dates
look. No handler, renderer, validation or fold is endowed with `Intl`. An
adapter gets a guarded one that refuses the host's defaults (it must name its
locale, its `timeZone` and its instant). It may store what a classifier returns
or a number, such as an offset, but never a formatter's text, which would bake
one host's CLDR into a row.

The refusal comes before release. `jessie.ts` lists `Intl` as a denied name
for every role but the adapter. For a handler it is a `check-facts` finding at
`lint`; for a validation, `derive.ts` refuses it at generation, since the
source is embedded in a migration.

## Sorting

Text sorts by the database's collation, because ordering happens in
PostgREST's `order=`, which has no `COLLATE`. mecha initialises the database
with ICU's root collation (`--icu-locale=und`). It uses root and not a language
because the collation is one per database and an app serves every declared
locale from the same rows. It uses ICU and not glibc because glibc reorders
between versions and silently invalidates text indexes, while PostgreSQL
records the ICU version and warns. Byte order, the alternative, puts every
accented letter after all of ASCII and "ana" after "Zoe". `order=` cannot
order per language.

## Rows in the reader's language

What a person wrote stays in the language they wrote it in. The design that
would translate rows is route-driven: a route's reads run under the page's
locale, the answer arrives at once in the source language, and the missing
(row, language) pairs are translated on the change feed
([pending](../PENDING.md#localization)). A prerendered document never carries
translated content: prerendering runs at build and translation at read.

## Rejected

- **A country or language field beside the tag** — two fields that must agree
  can disagree (`{language: "pt-BR", country: "PT"}` is writable and means
  nothing), and ISO 3166-1 cannot name `es-419`.
- **Catalogues authored in CUE** — every translator, management system and
  translation pipeline reads JSON; CUE would buy nothing and cost all of them a
  converter.
- **Falling back to the default language at run time** — a half-translated
  screen ships looking finished; the fallback exists only so `check i18n` can
  see it as a leak.
- **A per-route map of locale to URL segment** — a second place translators
  must be sent and a second thing the checker must learn.
- **Prefixing every locale, the default included** — a redirect on every
  bare-root visit from the primary market and a longer common URL.
- **Serving the default's prefixed spelling as a second document** — both
  URLs render and are indexed, and only a canonical tag stands between the app
  and split ranking.
- **Negotiating with 301** — the answer differs per reader, and a cached
  permanent redirect sends every reader where the first one went.
- **Negotiating a prefixed address** — it overrides a choice the reader made or
  a link they were handed.
- **The query parameter alone** — a weaker canonical signal than a path,
  fragmented caches, and it reads as a setting. It stays as the plain route's
  mechanism.
- **A subdomain per locale** — a certificate and a DNS record per locale and a
  worse local loop.
- **Keeping the hash router** — a hash is invisible to the server, so nothing
  under it can be crawled.
- **Prerendering as a whole-app switch** — the content/parameterized split is
  inside apps, not between them.
- **Endowing every role with `Intl` and letting the tier without ICU throw** —
  plv8's `ReferenceError` surfaces as a 500 that is retried forever, and at the
  earliest at `integrate`; a denied name at `lint` says which tier refuses it.
- **Polyfilling ICU in plv8** — possible only through a per-database
  `plv8.start_proc`, whose failure takes down every validated write, at about
  474 KB of FormatJS for three locales.
- **A libc collation, or a language's** — glibc reorders across versions and
  corrupts indexes silently; a language collation is one per database and
  serves one locale.
- **Translating every row into every locale on insert** — a translation per
  locale for rows nobody reads in it.
- **A client-side queue of rows awaiting translation** — it leaks the backend's
  mechanics into the terminal, where the route is already the unit of intent a
  screen declares.
