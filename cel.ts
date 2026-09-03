// The CEL front end: the one place a `cel:` string becomes syntax.
//
//   deno run --no-lock --node-modules-dir=none plugins/pronto/cel.ts "this.size() <= 8"
//
// parse() yields cel.expr.ParsedExpr, which toJson renders as the canonical
// protobuf-JSON of cel-spec's syntax.proto. That JSON is the whole contract:
// derive.ts writes it to .pronto/cel.json and every consumer downstream —
// SQL CHECK bodies, CUE field constraints, the terminal's enum reader, the
// lint that re-derives all three — reads the file and never this module. The
// CLI prints one expression's IR for the same reason a person would open the
// file: to see what the emitters are working from.

import { parse } from "npm:@bufbuild/cel@0.5.0";
import { toJson } from "npm:@bufbuild/protobuf@2.14.1";
import { ParsedExprSchema } from "npm:@bufbuild/cel-spec@0.5.0/cel/expr/syntax_pb.js";
import type { ParsedExpr } from "./cel-emit.ts";

// Expression ids come off a counter the parser keeps across calls, so the id
// a constraint's nodes wear depends on how many constraints were parsed
// before it — inserting one field would rewrite every later entry of
// .pronto/cel.json. They index a sourceInfo this IR does not carry, so the
// tree drops them and each entry is a function of its own source alone.
// Absent ids are the protobuf default, so the JSON still round-trips.
function stripIds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripIds);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).filter(([k]) => k !== "id").map(([k, v]) => [k, stripIds(v)]),
  );
}

export function parseCel(src: string): ParsedExpr {
  return stripIds(toJson(ParsedExprSchema, parse(src))) as ParsedExpr;
}

if (import.meta.main) {
  if (Deno.args.length === 0) {
    console.error('usage: cel.ts "<cel expression>"...');
    Deno.exit(1);
  }
  for (const src of Deno.args) {
    try {
      console.log(JSON.stringify(parseCel(src), null, 2));
    } catch (e) {
      console.error(`cel.ts: ${src}: ${(e as Error).message}`);
      Deno.exit(1);
    }
  }
}
