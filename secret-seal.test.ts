// The seal the page makes (omnishell's data-sync.js) is the seal the airlock
// opens (mecha's services/airlock/seal.ts): two statements of one envelope,
// held to each other here, where pronto already reads both trees.
import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1.0.11";
import { sealKid, sealValue } from "../omnishell/interpreter/data-sync.js";
import { generateSealKey, openSealed, SEALED, SealError, sealKeys, sealLabel } from "../../libraries/mecha/services/airlock/seal.ts";

Deno.test("what the page seals the airlock opens, for the row it was typed for and no other", async () => {
  const keys = await sealKeys(await generateSealKey());
  assertEquals(await sealKid(keys.current.public), keys.current.kid);
  const id = "00000000-0000-0000-0000-000000000001";
  const sealed = await sealValue(keys.current.public, keys.current.kid, "payment", "pin", id, "4321");
  assertMatch(sealed, SEALED);
  assertEquals(await openSealed(keys, sealed, sealLabel("payment", "pin", id)), "4321");
  await assertRejects(() => openSealed(keys, sealed, sealLabel("payment", "pin", "00000000-0000-0000-0000-000000000002")), SealError);
  await assertRejects(() => sealValue(keys.current.public, keys.current.kid, "payment", "pin", id, "x".repeat(319)), RangeError);
});
