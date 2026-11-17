// The edge-isolate fixture's isolate: echoes the request's JSON body with
// the sum WebAssembly computes, in the Workers module format. It imports the
// shim by an alias of its deno.json, after a module that imports it by a
// relative path (lib/sum.ts).
import { sum } from "./lib/sum.ts";
import add from "wasm";

const { exports } = await WebAssembly.instantiate(add) as unknown as { exports: { add(a: number, b: number): number } };

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/throw") throw new Error("the module refused");
    if (new URL(request.url).pathname === "/network-error") return Response.error();
    const body = await request.json() as { a: number; b: number };
    // Strings that end in .wasm.js, or read as an import, are the module's data.
    return Response.json({
      echoed: body,
      sum: sum(body.a, body.b),
      twice: exports.add(sum(body.a, body.b), 0),
      cdn: "https://cdn.example/parser.wasm.js",
      note: `example import("./docs/add.wasm.js") ${body.a}`,
      page: `${body.b}
import x from "../docs/add.wasm.js"`,
    });
  },
};
