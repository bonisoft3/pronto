# i18n is a contract

The ground: [`2026-08-31-one-ladder-one-grammar.md`](2026-08-31-one-ladder-one-grammar.md)
(state is rows; the program declares what must be verified),
[`../schema.cue`](../schema.cue) (the `#App`
contract, and dark-twin parity in `#Design`),
[`../../omnishell/docs/2026-07-30-the-binding-vocabulary.md`](../../omnishell/docs/2026-07-30-the-binding-vocabulary.md)
(a screen is an interpreted artifact, not a compiled one; no build step),
and [`../../../guis/iris`](../../../guis/iris), which proved the real-world
multilingual demands across six scripts (`en`, `es`, `pt`, `ru`, `he`, `kk`).

The claim: **static localization is an export-time contract, not a runtime guess.
An app states its languages via `#I18n` in `program.cue`; message catalogs are
standard JSON (`messages/*.json`) so translators, TMS platforms, and LLM
pipelines consume them without custom tooling; and CUE enforces key completeness
across locales at review time exactly as it enforces dark-palette twins. A secondary
locale missing a key from the default locale is an export refusal, not a runtime
fallback.** For dynamic user content, the route is the boundary: accessing or pre-fetching
a route (`<a href="..." data-prefetch>`) triggers translations for the entities that
route reads. Item-level client tracking is refused.

## Facts not to re-derive

Read out of this tree on 2026-09-09.

- **Screens have no bundler.** Omnishell screens are raw HTML interpreted at
  runtime by `screen.js`. Any i18n design relying on Webpack/Vite loaders, Babel
  macro extraction, or compile-time screen replication produces artifacts a reviewer
  did not sign, violating Pronto's core invariant ("the artifact a reviewer signs
  must be the artifact that runs").
- **Dark-twin parity is the established pattern for parallel definitions.**
  [`../schema.cue:73`](../schema.cue) closes `#Design.dark`:
  `close({for k, _ in D.colors {(k): string}})`. A token declared in light mode must
  exist in dark mode; an orphaned token in either palette is a CUE evaluation error.
  Message catalogs share this exact structural shape: every key present in the default
  language must exist in every supported translation.
- **The ecosystem speaks standard JSON, not CUE.** Translators, Translation
  Management Systems (Crowdin, Lokalise, Weblate), and AI translation pipelines
  ingest standard JSON key-value bundles. CUE imports JSON natively via
  `import "encoding/json"`; authoring messages in CUE syntax would create friction with
  the entire translation ecosystem for zero semantic gain.
- **Item-level client translation queues are an ad-hoc anti-pattern.** Having the
  client inspect individual rows, maintain sets of requested IDs, and emit ad-hoc
  translation batches leaks backend mechanics into the presentation tier. In Pronto,
  the screen and route (`#Screen.route`, `#Screen.reads`) define the boundary of intent.
  Accessing or pre-fetching the route is the sole trigger.
- **Eager translation of all user content is financially reckless.** Eagerly translating
  every user post across 6 languages burns 5 LLM inference calls per insert. In apps
  with UGC, <10% of content is ever viewed by speakers of non-author languages. The
  default must be lazy (route-driven), backed by standard link pre-fetching.
- **`guis/iris` proved the linguistic spectrum.**
  [`../../../guis/iris/i18n/routing.ts`](../../../guis/iris/i18n/routing.ts) carries
  `locales: ['en', 'es', 'pt', 'ru', 'he', 'kk']`. This exercises Cyrillic, 3-category
  Slavic plurals (`ru`), Turkic morphology (`kk`), and Right-to-Left bi-directional script
  (`he`). It also showed that forgetting `<html dir="rtl">` breaks Semitic layouts.

## The `#I18n` Contract in CUE

In [`../schema.cue`](../schema.cue), `#App.meta`
grows an `#I18n` declaration:

```cue
#I18n: {
    // The source locale used as the reference truth for key completeness.
    default: string & =~"^[a-z]{2}(-[A-Z]{2})?$"

    // All supported locales. Must include `default`.
    locales: [...string & =~"^[a-z]{2}(-[A-Z]{2})?$"] & [default, ..._]

    // Timezones this application supports for date-time rendering.
    time_zones?: [...string]
}
```

## Catalog Completeness & Verification

Catalogs live at `messages/{locale}.json` in the app directory:

```cue
import "encoding/json"

_defaultMessages: json.Unmarshal(files["messages/\(meta.i18n.default).json"])

// Every secondary locale must unify with the exact closed schema of the default:
for loc in meta.i18n.locales if loc != meta.i18n.default {
    _locMessages: json.Unmarshal(files["messages/\(loc).json"])
    _locMessages: close({for k, _ in _defaultMessages {(k): string}})
}
```

If `messages/pt.json` is missing `"no_items_yet"`, the build fails immediately with a
missing field error. A translation cannot ship half-finished.

## Emission to `shell.yaml`

Omnishell consumes static configuration through `shell.yaml`. In `emit.cue`, Pronto
projects the `#I18n` block directly into the shell manifest:

```yaml
meta:
  name: iris
  i18n:
    default: en
    locales: [en, es, pt, ru, he, kk]
    messages:
      en: messages/en.json
      es: messages/es.json
      pt: messages/pt.json
      ru: messages/ru.json
      he: messages/he.json
      kk: messages/kk.json
```

## Declarative Entity Localization: Eager vs. Route-Driven (Lazy)

In [`../schema.cue`](../schema.cue), an `#Entity` can declare
multilingual fields and a translation policy:

```cue
#Localization: {
    fields: [...string]

    // "lazy" (default): Route-driven. Translations are triggered on the backend
    // when a reader accesses or pre-fetches a route reading this entity in that locale.
    // "eager": Translate across all supported locales upon insert. Best for
    // static legal pages, system categories, and admin announcements.
    strategy: *"lazy" | "eager"
}

#Entity: {
    name: string
    // ...
    localization?: #Localization
}
```

### Artifact Derivations by Strategy

1. **When `strategy: "eager"`**:
   - Pronto derives `<entity>_translations` table.
   - Derives a Mecha CDC pipeline listening directly to `<entity>` inserts/updates,
     fanning out translation jobs to all `locales \ [user_language]`.

2. **When `strategy: "lazy"` (Platform Default)**:
   - Pronto derives `<entity>_translations` table.
   - Derives the localized PostgREST read view with server-side translation enqueuing
     when an untranslated row is accessed under a given locale.
   - Omnishell screens use standard `<a href="..." data-prefetch>` on links pointing
     to routes reading the entity, warming the translations naturally during navigation.
   - **Zero item-level queues or client-side request loops are emitted.**
