// The program the external-effect tests compile, and the cue calls they share.

// A program around one Payment machine whose `charging` state invokes `charge`;
// `effect`, `entity` and `vendored` are spliced into the effect, the entities
// and the vendored units, `machine` replaces the machine's states.
export function paymentProgram({ effect = "", machine = "", entity = "", vendored = "" } = {}): string {
  return `
package test

import "bonisoft.org/plugins/pronto"

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
    mecha: rows: PaymentMachine: {
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
    design: {
      colors: {
        primary: *"#111111" | string, secondary: *"#555555" | string, accent: *"#0055aa" | string, danger: *"#aa0000" | string,
        neutral: *"#fafafa" | string, surface: *"#ffffff" | string, border: *"#dddddd" | string, "surface-muted": *"#efefef" | string
      }
      dark: {
        primary: *"#f5f5f5" | string, secondary: *"#aaaaaa" | string, accent: *"#66aaff" | string, danger: *"#ff6666" | string,
        neutral: *"#111111" | string, surface: *"#1a1a1a" | string, border: *"#333333" | string, "surface-muted": *"#242424" | string
      }
      shell: nav: *"topbar" | "tabbar" | "sidebar" | "dock" | "custom"
    }
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

// A read, around the same machine: its `pricing` state invokes `rate`, a GET
// whose answer moves the row, counting its entries in `pricings`.
const PRICING = `
        pending: on: pay: "pricing"
        pricing: invoke: {
          src: "rate"
          onDone: {target: "settled", actions: [{assign: {failure: {raw: "outcome->'data'->>'usd'"}}}]}
          onError: {target: "failed", actions: [{assign: {failure: {raw: "outcome->>'kind'"}}}]}
        }
        settled: type: "final"
        failed: on: retry: "pending"`;

export const RATE = `rate: {
      input: {currency: "NEW.failure", day: "2026-11-16"}
      sink: {origin: "https://rates.example", credential: {scheme: "Bearer", secret: "RATES_KEY"}}
      request: {method: "GET", path: "/rates/{currency}{?day}"}
      count: "pricings"
      incarnation: "lineage"
      cacheControl: "max-age=3600"
      got: {retry: {limit: 1}, timeout: {request: 3000}}
    }`;

/** The payment program with its write replaced by the read `rate`, the count
 * column it names, and auth, which a read needs; `rate`, `count` and `auth`
 * change them. */
export function readProgram({ rate = RATE, count = `{name: "pricings", type: "int32"},\n          {name: "lineage", type: "uuid"},`, auth = true } = {}): string {
  const program = paymentProgram({ machine: PRICING })
    .replace(`{name: "failure", type: "string"},`, `{name: "failure", type: "string"},\n          ${count}`)
    .replace(/    effects: charge: \{[\s\S]*?\n    \}\n/, `    effects: {\n    ${rate}\n    }\n`);
  return auth ? program.replace("capabilities: {hatches: {},", "capabilities: {auth: {required: false, service: \"/auth\"}, hatches: {},") : program;
}

export async function cue(args: string[], code: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const child = new Deno.Command("cue", { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(code));
  await writer.close();
  const res = await child.output();
  return { success: res.success, stdout: new TextDecoder().decode(res.stdout), stderr: new TextDecoder().decode(res.stderr) };
}

export async function emitFiles(code: string): Promise<Record<string, { text: string; data?: any }>> {
  const res = await cue(["export", "-", "-e", "out", "--out", "json"], code);
  if (!res.success) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

