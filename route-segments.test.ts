import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";

Deno.test("nested resource routes translate every literal and preserve named parameters", async () => {
  const result = await new Deno.Command("cue", {
    args: ["export", ".", "-e", "routeSegments", "--out", "json"],
    cwd: new URL("./testdata/emit/", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
  const { routes, caddyfile } = JSON.parse(new TextDecoder().decode(result.stdout));
  assertEquals(routes[0].paths["en-US"], "/championship/:championship/team/:team/player/:slug");
  assertEquals(routes[0].paths["pt-BR"], "/campeonato/:championship/equipe/:team/jogador/:slug");
  assertStringIncludes(caddyfile, "/en/championship/[^/?]+/team/[^/?]+/player/[^/?]+/?");
  assert(!caddyfile.includes("/en/campeonato"));
});
