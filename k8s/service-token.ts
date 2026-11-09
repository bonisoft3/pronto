const secret = (await new Response(Deno.stdin.readable).text()).trim();
if (!secret) throw new Error("PGRST_JWT_SECRET is empty");
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const text = new TextEncoder();
const part = (value: unknown) => encode(text.encode(JSON.stringify(value)));
const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role: "service", sub: "00000000-0000-0000-0000-000000000000" })}`;
const key = await crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
console.log(`${body}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(body))))}`);
