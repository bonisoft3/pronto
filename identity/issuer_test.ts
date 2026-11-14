// identity.#Issuer as an application writes it: its export is what
// verifyBearer reads, and an entry that names no client, no operation or an
// issuer a token's `iss` could not equal exactly is refused where it is written.
import { type Issuer, verifyBearer } from "./bearer.ts";
import { base64url } from "./oidc.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const module = new URL("..", import.meta.url).pathname;
async function exported(entry: string): Promise<{ success: boolean; value?: Record<string, Issuer & { origin: string }>; stderr: string }> {
  const code = `import "github.com/bonisoft3/pronto/identity"\nissuers: [Name=string]: identity.#Issuer & {name: Name}\nissuers: ${entry}\n`;
  const child = new Deno.Command("cue", { args: ["export", "--out", "json", "-e", "issuers", "-"], cwd: module, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(code));
  await writer.close();
  const res = await child.output();
  const stderr = new TextDecoder().decode(res.stderr);
  return { success: res.success, value: res.success ? JSON.parse(new TextDecoder().decode(res.stdout)) : undefined, stderr };
}

const entry = (over = "") => `"issuer-a": {
  issuer: "https://id.example/realms/guests"
  azp: ["web"]
  require: operationType: ["ORDER_FLOW"]
  map: {
    operation_kind: {claim: "operationType", values: ORDER_FLOW: "ORDER"}
    operation_id: claim: "operationId"
  }
  amr: ["otp"]
  ${over}
}`;

Deno.test("an issuer's export is what the bearer check reads, with its discovery and origin derived", async () => {
  const res = await exported(entry());
  assertEquals(res.success, true, res.stderr);
  const issuer = res.value!["issuer-a"];
  assertEquals([issuer.name, issuer.kind, issuer.alg, issuer.audience], ["issuer-a", "bearer", "RS256", []]);
  assertEquals(issuer.discovery, "https://id.example/realms/guests/.well-known/openid-configuration");
  assertEquals(issuer.origin, "https://id.example");
  assertEquals(issuer.claimMax, 200, "the upgrade's bound, emitted for the check");
  // Naming the issuer's own discovery is the same entry.
  const named = await exported(entry(`discovery: "https://id.example/realms/guests/.well-known/openid-configuration"`));
  assertEquals(named.success, true, named.stderr);
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const enc = new TextEncoder();
  const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", kid: "k1" })));
  const body = base64url(enc.encode(JSON.stringify({ iss: issuer.issuer, azp: "web", exp: 1_800_000_300, operationType: "ORDER_FLOW", operationId: "op-1" })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${head}.${body}`)));
  const operation = await verifyBearer(`${head}.${body}.${base64url(sig)}`, { issuers: [issuer], keys: () => () => Promise.resolve(jwk), now: 1_800_000_000 });
  assertEquals(operation, { operation_kind: "ORDER", operation_id: "op-1", amr: ["otp"], idp: "issuer-a" });
});

Deno.test("a local stand-in's issuer is http on loopback, and its origin keeps the port", async () => {
  const res = await exported(entry().replace("https://id.example/realms/guests", "http://localhost:18080/realms/guests"));
  assertEquals(res.success, true, res.stderr);
  assertEquals(res.value!["issuer-a"].origin, "http://localhost:18080");
  // Every port a URL can name, to the last, and as many methods and characters as the upgrade takes.
  const edge = await exported(
    entry().replace("https://id.example/realms/guests", "https://id.example:65535/realms/guests")
      .replace(`amr: ["otp"]`, `amr: ${JSON.stringify(Array.from({ length: 8 }, (_, i) => `m${i}`))}`)
      .replace(`values: ORDER_FLOW: "ORDER"`, `values: ORDER_FLOW: "${"x".repeat(200)}"`),
  );
  assertEquals(edge.success, true, edge.stderr);
  assertEquals(edge.value!["issuer-a"].origin, "https://id.example:65535");
});

Deno.test("an entry with no client, no operation, or an issuer no iss equals exactly is refused", async () => {
  const refused = [
    entry().replace(`azp: ["web"]`, "azp: []"),
    entry().replace(`azp: ["web"]`, ""),
    entry().replace(`operation_id: claim: "operationId"`, ""),
    entry().replace(`claim: "operationType", `, ""),
    entry().replace(`amr: ["otp"]`, "amr: []"),
    entry().replace(`amr: ["otp"]`, `amr: ["One Time"]`),
    entry().replace("https://id.example/realms/guests", "http://id.example/realms/guests"),
    entry().replace("https://id.example/realms/guests", "https://id.example/realms/guests/"),
    entry().replace("https://id.example/realms/guests", "https://id.example/realms/guests?x=1"),
    entry().replace("https://id.example/realms/guests", "https://id.example:99999/realms/guests"),
    entry().replace("https://id.example/realms/guests", "https://id.example:0/realms/guests"),
    entry().replace(`values: ORDER_FLOW: "ORDER"`, `values: ORDER_FLOW: "${"x".repeat(201)}"`),
    entry().replace(`values: ORDER_FLOW: "ORDER"`, `values: ORDER_FLOW: "PEDIDO_É"`),
    entry(`claimMax: 500`),
    // Discovery is the issuer's own: another URL's answer could claim any issuer.
    entry(`discovery: "https://evil.example/.well-known/openid-configuration"`),
    entry(`discovery: "https://id.example/.well-known/openid-configuration"`),
    entry().replace(`amr: ["otp"]`, `amr: ${JSON.stringify(Array.from({ length: 9 }, (_, i) => `m${i}`))}`),
    entry().replace(`amr: ["otp"]`, `amr: ["${"o".repeat(201)}"]`),
    `"${"a".repeat(201)}": ${entry().slice(`"issuer-a": `.length)}`,
    entry(`alg: "none"`),
    entry(`kind: "oidc-login"`),
    entry(`secret: "s3cr3t"`),
    entry(`map: operation_sub: claim: "sub"`),
    `"Issuer A": ${entry().slice(`"issuer-a": `.length)}`,
  ];
  for (const e of refused) {
    const res = await exported(e);
    assertEquals(res.success, false, e);
  }
});
