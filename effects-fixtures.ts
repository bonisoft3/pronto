// The program the external-effect tests compile, and the cue calls they share.

// A program around one Payment machine whose `charging` state invokes `charge`;
// `effect`, `entity` and `vendored` are spliced into the effect, the entities
// and the vendored units, `machine` replaces the machine's states.
export function paymentProgram({ effect = "", machine = "", entity = "", vendored = "" } = {}): string {
  return `
package test

import "github.com/bonisoft3/pronto"

app: pronto.#App & {
  meta: {
    name: "test-effects"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Payment: {
        table: "payment"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "status", type: "string"},
          {name: "total", type: "decimal", precision: 12, scale: 2},
          {name: "failure", type: "string"},
        ]
      }
      ${entity}
    }
    machines: PaymentMachine: {
      name: "PaymentMachine"
      entity: "Payment"
      field: "status"
      initial: "pending"
      states: {
        ${machine || `
        pending: on: pay: "charging"
        charging: invoke: {
          src: "charge"
          onDone: "settled"
          onError: {target: "failed", actions: [{assign: {failure: {raw: "outcome->>'kind'"}}}]}
        }
        settled: type: "final"
        failed: on: retry: "pending"`}
      }
    }
    effects: charge: {
      input: {amount: "NEW.total", currency: "BRL"}
      sink: {origin: "https://api.acquirer.example", idempotent: true}
      note: "the acquirer deduplicates on Idempotency-Key"
      ${effect}
    }
  }
  capabilities: {hatches: {}, vendored: {${vendored}}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{table: "payment", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
      forms: []
      states: []
    }
    handlers: {}
    design: {}
    flows: {}
  }
}

_terminal: (pronto.#DefaultTerminal & {code: app}).out
_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: app, terminal: _terminal, cluster: _cluster}).out
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}).files
`;
}

export async function cue(args: string[], code: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const child = new Deno.Command("cue", { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(code));
  await writer.close();
  const res = await child.output();
  return { success: res.success, stdout: new TextDecoder().decode(res.stdout), stderr: new TextDecoder().decode(res.stderr) };
}

export async function emitFiles(code: string): Promise<Record<string, { text: string }>> {
  const res = await cue(["export", "-", "-e", "out", "--out", "json"], code);
  if (!res.success) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

