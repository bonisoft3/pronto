// Re-fetch a vendored vocabulary from the archive its source.json names.
//
//   deno run --allow-net --allow-read=. --allow-write=. \
//     plugins/pronto/scales/refresh.ts <tree> [version]
//
// The only thing here that reaches the network, and nothing in `just generate`
// or `just lint` runs it: the checked-in bytes are the input to every rule, and
// a rule that could re-download its own subject would be grading whatever the
// registry served this morning. A version bump is therefore a reviewed diff of
// stylesheets, which is what makes the emitted names auditable against upstream
// by reading.
//
// The digest is verified before a byte is written. It is not the provenance
// check — that is invariants.sql's quotation rule, which holds the published
// vocabulary equal to these files continuously, where this runs once. It is the
// narrower claim that the archive is the one source.json names.

import { decodeBase64 } from "jsr:@std/encoding@1.0.5/base64";
import { UntarStream } from "jsr:@std/tar@0.1.6/untar-stream";
import { type Source, vendoredNames } from "../scales.ts";


function fail(msg: string): never {
  console.error(`pronto scales refresh: ${msg}`);
  Deno.exit(1);
}

const tree = Deno.args[0] ?? fail("usage: refresh.ts <tree directory under scales/> [version]");
const dir = new URL(`./${tree}/`, import.meta.url);
const source: Required<Source> = JSON.parse(await Deno.readTextFile(new URL("source.json", dir)));

// A bump rewrites url, version and integrity from the registry; without one the
// run re-verifies what is checked in, which is how a corrupted vendoring is
// found without trusting the network to tell the truth about itself.
// The rewrite below substitutes source.version, so a tree whose version has
// already drifted from its url would re-verify the OLD archive, match the old
// digest and rewrite source.json with the drift intact — this tool blessing the
// exact residue a half-finished bump leaves. Checked before the fetch, so the
// network is never consulted about a tree that is already inconsistent.
if (!source.url.includes(source.version)) {
  fail(
    `source.json states version ${source.version}, and its url does not name it:\n  ${source.url}\n` +
      "  a bump that moved one and not the other leaves the url pinning the old archive",
  );
}
const version = Deno.args[1] ?? source.version;
const url = source.url.replaceAll(source.version, version);

const response = await fetch(url);
if (!response.ok) fail(`${url}: ${response.status} ${response.statusText}`);
const archive = new Uint8Array(await response.arrayBuffer());

const [algorithm, expected] = source.integrity.split("-", 2);
if (algorithm !== "sha512") fail(`source.json states integrity ${algorithm}, and only sha512 is verified here`);
const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", archive));
const actual = btoa(String.fromCharCode(...digest));
if (version === source.version && actual !== expected) {
  fail(
    `${url} hashes sha512-${actual}\n  source.json states sha512-${expected}\n` +
      "  the archive at that URL is not the one this tree quotes",
  );
}
// A bump has no digest to check against yet, so the one it writes is the one it
// verified the extraction against — a byte that changed in flight would have to
// change consistently in both, which is the property a lockfile has.
if (version !== source.version) {
  console.error(`refresh: ${source.origin} ${source.version} -> ${version}, sha512-${actual}`);
}
if (decodeBase64(actual).length !== 64) fail("the digest did not decode to 64 bytes");

const entries: Record<string, Uint8Array> = {};
const stream = new Blob([archive as BufferSource]).stream()
  .pipeThrough(new DecompressionStream("gzip"))
  .pipeThrough(new UntarStream());
for await (const entry of stream) {
  const name = entry.path.replace(/^package\//, "");
  if (!source.files.includes(name)) {
    await entry.readable?.cancel();
    continue;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry.readable ?? new ReadableStream<Uint8Array>()) chunks.push(chunk);
  entries[name] = new Uint8Array(await new Blob(chunks as BufferSource[]).arrayBuffer());
}

const missing = source.files.filter((f) => entries[f] === undefined);
if (missing.length > 0) fail(`${url} carries none of: ${missing.join(", ")}`);

for (const [file, name] of vendoredNames(source.files)) {
  await Deno.writeFile(new URL(name, dir), entries[file]);
}
await Deno.writeTextFile(
  new URL("source.json", dir),
  JSON.stringify({ ...source, version, url, integrity: `sha512-${actual}` }, null, 2) + "\n",
);
console.error(`refresh: ${source.files.length} files <- ${url}`);
