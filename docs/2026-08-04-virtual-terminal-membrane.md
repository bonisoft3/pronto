# The Virtual Terminal: Host-Side Read-Only Membrane & Sandbox Event Router

This document codifies the core architecture and boundary metaphor for the **Virtual Terminal** inside `pronto-design`.

## Architectural Topology

```
[ Native Host Environment ]                     [ SES Isolated Compartment ]
  Real DOM Element (Mutating)                     
         │
         ▼ (Wrapped via Proxy)
  Read-only Membrane ────────────────────────> Router -> `.matches()` (Safe)
                                                    │
                                                    ▼
                                              Jessie Pipeline (Pure Data)
```

## The Four Pillars

1. **Host-Side Read-Only Membrane (`createReadOnlyMembrane(element)`)**
   - Pre-wraps native DOM elements before handing them across the SES compartment boundary.
   - Explicitly whitelists non-mutating query vectors:
     - Selector matching: `.matches(selector)`
     - Element attributes & metadata: `.id`, `.className`, `.tagName`, `.type`, `.value`, `.dataset` (frozen shallow copy), `.getAttribute()`, `.hasAttribute()`
     - Structural traversal: `.parentElement`, `.parentNode`, `.closest()` (each recursively returning a wrapped read-only membrane).
   - Strictly blocks all mutation operations (`setAttribute`, `appendChild`, `removeChild`, `innerHTML`, `remove`, `click()`, property mutations) with a clear `[Membrane Violation]` exception.

2. **Isolated SES Compartment Execution**
   - The event router and Jessie roles (handlers, adapters, renderers) execute within locked-down `Compartment` sandboxes.
   - No ambient access to `document`, `window`, `fetch`, or clock/timer primitives.
   - Handlers receive event contexts via read-only membranes and return pure data descriptions/intents (TEA `update` pattern: `Msg -> Model -> (Model, Cmd Msg)`).

3. **DOM-as-a-Database**
   - Transient application state lives directly in HTML attributes (`data-current-state`, `data-context-*`).
   - The DOM tree functions as the primary reactive single source of truth for UI state, eliminating duplicate in-memory object stores.

4. **Universal DOM Patcher Sink**
   - State transformations emit declarative patch operations (RFC 6902 JSON Patches or JsonML element patches).
   - The Host Environment consumes these pure patch streams and executes surgical, atomic DOM mutations onto the native DOM.

## Verification

The membrane implementation is verified under Deno and SES in `plugins/omnishell/interpreter/membrane-smoke.js` (73 total test suites passing cleanly across `plugins/omnishell/interpreter`).
