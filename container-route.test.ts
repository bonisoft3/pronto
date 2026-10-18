// A container hatch that declares a route is reached through the door: the
// emitted Caddyfile proxies the prefix to the service the program's cluster
// unification defines, with the prefix kept, as /auth/* is. One that declares
// none is reached by nothing outside the cluster, as before.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const routed = (route: string) => `
app: capabilities: hatches: signin: {
  kind: "container", note: "exchanges a provider's sign-in for a session",
  route: ${route}
}
`;

Deno.test("a container hatch's route is proxied to its service, prefix kept", async () => {
  const files = await emitFiles(paymentProgram() + routed(`{path: "/signin", port: 8000}`));
  assertStringIncludes(
    files["docker/Caddyfile"].text,
    "  handle /signin/* {\n    reverse_proxy {$PRONTO_MESH:signin:8000} {\n      header_up dapr-app-id signin\n    }\n  }\n",
  );
});

Deno.test("a container hatch without a route is not reached through the door", async () => {
  const files = await emitFiles(paymentProgram() + `
app: capabilities: hatches: worker: {kind: "container", note: "a hand-written worker"}
`);
  assertEquals(files["docker/Caddyfile"].text.includes("dapr-app-id worker"), false);
});

Deno.test("a route may not take the door's own prefixes, nest, or be given to another hatch kind", async () => {
  for (const route of [
    `{path: "/auth", port: 8000}`,
    `{path: "/crud", port: 8000}`,
    `{path: "/electric", port: 8000}`,
    `{path: "/shell", port: 8000}`,
    `{path: "/health", port: 8000}`,
    `{path: "/signin/google", port: 8000}`,
    `{path: "signin", port: 8000}`,
    `{path: "/signin", port: 0}`,
  ]) {
    const res = await cue(["export", "-", "-e", "app"], paymentProgram() + routed(route));
    assertEquals(res.success, false, route);
  }
  const sql = await cue(["export", "-", "-e", "app"], paymentProgram() + `
app: capabilities: hatches: legacy: {
  kind: "sql", note: "predates the vocabulary", files: ["services/database/sql/legacy.sql"],
  route: {path: "/legacy", port: 8000}
}
`);
  assertEquals(sql.success, false);
});
