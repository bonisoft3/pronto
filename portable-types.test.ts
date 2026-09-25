import { strict as assert } from "node:assert"
import { portableTypeSource } from "./refresh-portable-types.ts"

Deno.test("the standalone type runtime is the generated authoritative copy", async () => {
  assert.equal(await Deno.readTextFile(new URL("./portable-types.ts", import.meta.url)), await portableTypeSource())
})
