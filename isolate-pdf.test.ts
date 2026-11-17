// pronto's stock pdf isolate (isolates/pdf, [[docs/isolate-hatches#Stock isolates]]),
// built as every release builds it (mecha's #IsolateBuild): its module answers
// a document definition with that document's PDF, and behind the host that
// serves it outside Cloudflare (#IsolateHost) a document's size is bounded by
// the hatch's heap, not by any check of its own.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { stowed } from "@bonisoft3/mecha/services/airlock/blobs.ts";
import { pdfOf, receipt, RECEIPT_SHA256, sha256, shape } from "./testdata/pdf-isolate/receipt.ts";

const PRONTO = new URL(".", import.meta.url).pathname;
const FILES = ["isolates/pdf/main.ts", "isolates/pdf/deno.json", "isolates/pdf/deno.lock"];

async function built(host: boolean): Promise<string> {
  const exported = await new Deno.Command("cue", { args: ["export", "./clusters:mecha", "-e", "#IsolateBuild", "--out", "text"], cwd: PRONTO, stdout: "piped", stderr: "piped" }).output();
  assert(exported.success, new TextDecoder().decode(exported.stderr));
  // Deno loads a module by its real path: macOS's temporary directory is a symlink.
  const out = await Deno.realPath(await Deno.makeTempDir());
  const build = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-config", new TextDecoder().decode(exported.stdout)],
    env: { ISOLATE_ROOT: PRONTO, ISOLATE_OUT: out, ISOLATE_ENTRYPOINT: FILES[0], ISOLATE_FILES: JSON.stringify(FILES), ...(host ? { ISOLATE_HOST: "1" } : {}) },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  assert(build.success, "the stock pdf isolate does not build");
  return out;
}

// A table of `rows` rows, a page per some 38 of them.
const statement = (rows: number) => ({
  content: [{
    table: {
      headerRows: 1,
      widths: ["*", "auto", "auto"],
      body: [["Item", "Data", "Valor"], ...Array.from({ length: rows }, (_, i) => [`Despesa ${i + 1} com uma descrição um pouco mais longa`, `2026-11-${String(i % 28 + 1).padStart(2, "0")}`, `R$ ${(i * 37.5).toFixed(2)}`])],
    },
  }],
});

Deno.test("the stock pdf isolate answers a document definition with its PDF", async () => {
  const out = await built(false);
  try {
    const { default: module } = await import(`file://${out}/entry.js`) as { default: { fetch(request: Request): Promise<Response> } };
    const render = (body: string) => module.fetch(new Request("http://pdf/", { method: "POST", body }));
    const answered = await render(JSON.stringify(receipt));
    assertEquals(answered.status, 200);
    // The PDF arrives as an effect's answer carries bytes: a blob a handler
    // answers as it is.
    const bytes = await pdfOf(answered);
    assertEquals(shape(bytes), { header: "%PDF-1.3", trailer: true, pages: 1, fonts: ["Roboto-Italic", "Roboto-Medium", "Roboto-MediumItalic", "Roboto-Regular"] });
    // Dated by its definition, the document is the same bytes every time.
    assertEquals(await sha256(bytes), RECEIPT_SHA256);
    assertEquals(await sha256(await pdfOf(await render(JSON.stringify(receipt)))), RECEIPT_SHA256);

    // A handler answers the blob as the sink answered it, and the airlock
    // stores the PDF itself under its content key.
    const stored = new Map<string, Uint8Array>();
    const store = { put: async (key: string, bytes: Uint8Array) => void stored.set(key, bytes), get: () => Promise.reject(), url: (key: string) => key };
    const sunk = await (await render(JSON.stringify(receipt))).json();
    assertEquals(await stowed({ done: { receipt: sunk } }, "receipt", store), { done: { receipt: `/blobs/mecha-objects/effects/${RECEIPT_SHA256}.pdf` } });
    assertEquals(await sha256(stored.get(`effects/${RECEIPT_SHA256}.pdf`) as Uint8Array<ArrayBuffer>), RECEIPT_SHA256);

    // What no retry would change is answered, not thrown: a body that is no
    // JSON, and a definition pdfmake itself refuses.
    const garbled = await render("{");
    assertEquals(garbled.status, 400);
    assertStringIncludes(await garbled.text(), "the body is no JSON");
    const refused = await render(JSON.stringify({ content: [{ table: { body: "rows" } }] }));
    assertEquals(refused.status, 422);
    assertStringIncludes(await refused.text(), "pdfmake refused the document");
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("behind the host, the stock pdf isolate's heap bounds the document", async () => {
  const out = await built(true);
  const port = 19000 + Math.floor(Math.random() * 1000);
  const host = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--allow-net", "--allow-read", "--allow-run", "--allow-sys=networkInterfaces", `${out}/host.js`, `${out}/entry.js`, String(port), "50000", "96"],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  try {
    for (const deadline = Date.now() + 15000; ;) {
      try {
        (await Deno.connect({ hostname: "127.0.0.1", port })).close();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const render = (definition: unknown) => fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(definition) });
    assertEquals(await sha256(await pdfOf(await render(receipt))), RECEIPT_SHA256);

    // A long statement, 132 pages, fits the 96 MiB the hatch states, well
    // inside the deadline.
    const started = Date.now();
    const long = await render(statement(5000));
    assertEquals(long.status, 200);
    assertEquals(shape(await pdfOf(long)).pages, 132);
    assert(Date.now() - started < 25000, `the long statement took ${Date.now() - started} ms`);

    // Twice as long is past that heap: its process ends, the call's
    // connection breaks before any status, and the host answers again.
    let broken = false;
    try {
      await (await render(statement(10000))).arrayBuffer();
    } catch {
      broken = true;
    }
    assert(broken, "a statement past the heap was answered");
    assertEquals(await sha256(await pdfOf(await render(receipt))), RECEIPT_SHA256);
  } finally {
    host.kill("SIGKILL");
    await host.output();
    await Deno.remove(out, { recursive: true });
  }
});
