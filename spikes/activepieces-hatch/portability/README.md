# Local Activepieces piece portability spike

This is an experiment, not a production hatch or migration. `piece.ts` is an ordinary Activepieces `createPiece`/`createAction` module with secret-text auth and standard properties. It has no Pronto or Mecha imports and closes over no app configuration. `runner.ts` imports it statically, selects actions, adapts invocation context, and supplies auth per invocation. The example action checks a fixed token only to demonstrate the shape; it is not an authentication system.

The proposed boundary is a reusable framework runner plus app-owned static piece registrations. A CUE declaration opts an app into named pieces and action names; compilation should resolve those names against the app's explicit import registry, reject unknown or duplicate names and generate an immutable allowlist and descriptors. The framework runner should supply the adapter and enforce that allowlist. The container hatch bridge is one specialization: receive a hatch invocation, resolve its secret reference at execution time, invoke the runner, and return the result through the hatch protocol. Other hosts can use the same runner without a container bridge. The sibling [[../declaration/README|declaration prototype]] illustrates the CUE contract; this spike does not compile it or connect it to the hand-written registry and whitelist. A real compiler must enforce their correspondence and pin the piece package as well as the SDK.

Here the runner supports only secret-text auth and `propsValue`, passing the SDK's `{type: "SECRET_TEXT", secret_text: ...}` connection shape. Access to any other context field throws. This deliberately excludes stores, files, flows, server APIs, triggers, OAuth refresh and the rest of the engine. Support requires an explicit adapter contract and tests per capability. A static import also does not make arbitrary npm pieces Deno compatible: their transitive dependencies and Node API assumptions must be tested individually.

The test demonstrates that calling `action.run` directly does **not** apply the SDK property's `defaultValue` or enforce `required`: missing fields reach the action as `undefined`. A production runner must define and implement input validation, defaulting and supported property/auth types, or use the corresponding Activepieces engine behavior; metadata alone is not execution semantics. Dynamic properties, validation hooks, retries, and output/error behavior need separate investigation.

Descriptors contain names only and this example's successful result contains no secret. This is not a secrecy guarantee: trusted piece code can return, log, transmit, or include credentials in errors. Restricting descriptor fields avoids automatically copying auth into metadata, but arbitrary outputs/errors need a defined policy; simple redaction cannot establish isolation. The host must treat piece code as trusted or provide an independently designed security boundary.

## Reproduce

From this directory, with Deno 2.9.7 and Node on PATH:

```sh
deno task --frozen-lockfile build
deno task --frozen-lockfile test
deno test --allow-env package_test.js
node package-smoke.cjs
```

On 2026-10-28, Deno 2.9.7 ran all three tests successfully, esbuild 0.25.10 bundled the piece and runner for Node, and existing Node v26.10.0 printed `{ greeting: 'Hello, Ada!' }`. Deno installed npm dependencies locally; no Node installation was needed. The private package exports the bundled piece through its package root; Deno and Node each loaded that root and called its action independently of the runner. This proves package resolution and invocation for this fixture, not installation or execution in the official Activepieces platform, a published package, or general compatibility. `deno.lock` pins the resolved graph; `dist/` and `node_modules/` are disposable.
