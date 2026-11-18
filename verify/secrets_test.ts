import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { declaredSecrets, dispatcherSecrets, requireSecrets, wranglerSecretNames } from "./secrets.ts";

const manifest = JSON.stringify({
  effects: {
    pay: { credential: { header: "Authorization", scheme: "Bearer", secret: "PAY_KEY" } },
    sign: { secrets: ["SIGNING_KEY", "PAY_KEY"] },
    plain: {},
    quote: { edgeOrigin: { secret: "VENDOR_ORIGIN" } },
    fixed: { edgeOrigin: "https://api.vendor.example" },
  },
});

// A named origin is held where its key is: a deployment without it would
// fail every run of the effect, so verify and the publish ask for it by name.
Deno.test("a manifest's handlers', credentials' and named origins' secrets, once each", () => {
  assertEquals(declaredSecrets(manifest), ["PAY_KEY", "SIGNING_KEY", "VENDOR_ORIGIN"]);
});

// An AI setting unset on a deployment fails every image it draws: verify and
// the publish ask for it by name, beside the effects' own.
Deno.test("the dispatcher's secrets are the effects' and its AI settings', once each", () => {
  assertEquals(dispatcherSecrets(manifest, { AI_IMAGE_HEAVY: {}, PAY_KEY: {} }), ["AI_IMAGE_HEAVY", "PAY_KEY", "SIGNING_KEY", "VENDOR_ORIGIN"]);
});

// Regression: a missing key reached the edge's sink as a 401 on the first order.
Deno.test("a declared secret the target lacks is named, and a value is never asked for", () => {
  requireSecrets(["A"], ["A", "B"]);
  assertThrows(() => requireSecrets(["A", "C"], ["A"]), Error, "holds no C");
});

Deno.test("wrangler's listing reads as names", () => {
  assertEquals(wranglerSecretNames('[{"name":"A","type":"secret_text"}]'), ["A"]);
});
