import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { declaredSecrets, requireSecrets, wranglerSecretNames } from "./secrets.ts";

const manifest = JSON.stringify({
  effects: {
    pay: { credential: { header: "Authorization", scheme: "Bearer", secret: "PAY_KEY" } },
    sign: { secrets: ["SIGNING_KEY", "PAY_KEY"] },
    plain: {},
  },
});

Deno.test("a manifest's handlers' and credentials' secrets, once each", () => {
  assertEquals(declaredSecrets(manifest), ["PAY_KEY", "SIGNING_KEY"]);
});

// Regression: a missing key reached the edge's sink as a 401 on the first order.
Deno.test("a declared secret the target lacks is named, and a value is never asked for", () => {
  requireSecrets(["A"], ["A", "B"]);
  assertThrows(() => requireSecrets(["A", "C"], ["A"]), Error, "holds no C");
});

Deno.test("wrangler's listing reads as names", () => {
  assertEquals(wranglerSecretNames('[{"name":"A","type":"secret_text"}]'), ["A"]);
});
