import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1"
import { releaseManifest, type ReleaseContent } from "./release.ts"

Deno.test("a template change keeps the store and code contract", async () => {
  const files = new Map([
    ["shell/shell.json", "{}"],
    ["shell/handlers/edit.js", "export default 1"],
    ["shell/screens/team.html", "<main>old</main>"],
    ["shell/screens/team.css", "main{}"],
  ])
  const before = await releaseManifest("omnishell:one", files)
  files.set("shell/screens/team.html", "<main>new</main>")
  const after = await releaseManifest("omnishell:one", files)
  assertEquals(before.contract, after.contract)
  assertNotEquals(before.id, after.id)

  files.set("shell/handlers/edit.js", "export default 2")
  assertNotEquals(after.contract, (await releaseManifest("omnishell:one", files)).contract)
  assertNotEquals(after.contract, (await releaseManifest("omnishell:two", files)).contract)
})

Deno.test("a screen without a stylesheet cannot be released", async () => {
  await assertRejects(
    () => releaseManifest("runtime", new Map([["shell/screens/team.html", "<main></main>"]])),
    Error,
    "no matching stylesheet",
  )
})

Deno.test("the contract hashes runtime bytes as well as the runtime pin", async () => {
  const files = new Map([
    ["shell/index.html", '<script type="module" src="./boot.js"></script>'],
    ["shell/boot.js", 'import "/omnishell/interpreter/shell.js";'],
    ["omnishell/interpreter/shell.js", 'import "./dependency.js";'],
    ["omnishell/interpreter/dependency.js", "export const version = 1;"],
  ])
  const before = await releaseManifest("runtime@one", files)
  assertEquals(Object.keys(before.assets), [...files.keys()].sort())
  files.set("omnishell/interpreter/dependency.js", "export const version = 2;")
  const after = await releaseManifest("runtime@one", files)
  assertNotEquals(before.contract, after.contract)
  assertNotEquals(before.id, after.id)
})

Deno.test("a binary unit dependency changes the code contract", async () => {
  const files = new Map<string, ReleaseContent>([
    ["shell/units/engine/worker.js", 'importScripts("./engine.js");'],
    ["shell/units/engine/engine.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])],
  ])
  const before = await releaseManifest("runtime", files)
  files.set("shell/units/engine/engine.wasm", new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]))
  const after = await releaseManifest("runtime", files)
  assertNotEquals(before.assets["shell/units/engine/engine.wasm"], after.assets["shell/units/engine/engine.wasm"])
  assertNotEquals(before.contract, after.contract)
  assertNotEquals(before.id, after.id)
})

Deno.test("binary release hashes preserve malformed UTF8 bytes", async () => {
  const path = "shell/units/engine/engine.wasm"
  const first = new Uint8Array([0, 255, 128])
  const second = new Uint8Array([0, 254, 129])
  assertEquals(new TextDecoder().decode(first), new TextDecoder().decode(second))
  const a = await releaseManifest("runtime", new Map([[path, first]]))
  const b = await releaseManifest("runtime", new Map([[path, second]]))
  assertNotEquals(a.assets[path], b.assets[path])
  assertNotEquals(a.contract, b.contract)
  assertNotEquals(a.assets[path], (await releaseManifest("runtime", new Map([[path, new TextDecoder().decode(first)]]))).assets[path])
  const text = "worker: café"
  assertEquals(
    (await releaseManifest("runtime", new Map([[path, text]]))).assets[path],
    (await releaseManifest("runtime", new Map([[path, new TextEncoder().encode(text)]]))).assets[path],
  )
})

Deno.test("release identity uses code-point ordering independently of the host locale", async () => {
  const compare = String.prototype.localeCompare
  let manifest
  try {
    String.prototype.localeCompare = () => { throw new Error("release ordering must not depend on a locale") }
    manifest = await releaseManifest("runtime", new Map([
      ["shell/units/y.js", "export const y = 1"],
      ["shell/units/j.js", "export const j = 1"],
      ["shell/units/IZ.js", "export const upper = 1"],
      ["shell/units/ia.js", "export const lower = 1"],
    ]))
  } finally { String.prototype.localeCompare = compare }
  assertEquals(Object.keys(manifest!.assets), [
    "shell/units/IZ.js", "shell/units/ia.js", "shell/units/j.js", "shell/units/y.js",
  ])
})
