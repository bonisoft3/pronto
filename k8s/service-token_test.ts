Deno.test("internal service tokens verify only with the deployed signing key", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", new URL("./service-token.ts", import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("deployment-signing-key\n"));
  await writer.close();
  const output = await child.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const [header, payload, signature] = new TextDecoder().decode(output.stdout).trim().split(".");
  const decode = (part: string) => Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
  if (claims.role !== "service" || claims.sub !== "00000000-0000-0000-0000-000000000000") throw new Error("wrong internal identity");
  for (const secret of ["deployment-signing-key", "different-key"]) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, decode(signature), new TextEncoder().encode(`${header}.${payload}`));
    if (valid !== (secret === "deployment-signing-key")) throw new Error("signature does not bind the deployed key");
  }
});
