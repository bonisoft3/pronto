import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";

Deno.test("mecha machine compiles statechart into PostgreSQL 010_machines.sql", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-machine"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Challenge: {
        table: "challenge"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "status", type: "string"},
          {name: "created_at", type: "timestamp"},
        ]
      }
    }
    machines: {
      ChallengeMachine: {
        name: "ChallengeMachine"
        entity: "challenge"
        field: "status"
        initial: "pending"
        states: {
          pending: {
            after: {
              "60000": "expired"
            }
            on: {
              accept: {
                target: "accepted"
                actions: [{
                  effect: {
                    op: "ensure"
                    table: "audit_log"
                    values: {event: "challenge_accepted"}
                  }
                }]
              }
              decline: "declined"
            }
          }
          accepted: {type: "final"}
          declined: {type: "final"}
          expired: {type: "final"}
        }
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{entity: "Challenge"}]
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}).files

`;

  const cmd = new Deno.Command("cue", {
    args: ["export", "-", "-e", "out", "--out", "json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, true);

  const files = JSON.parse(new TextDecoder().decode(res.stdout));
  const sql = files["services/database/migrations/010_machines.sql"]?.text;
  assertEquals(typeof sql, "string");

  // Check state constraint
  assertStringIncludes(sql, 'ALTER TABLE "challenge" ADD CONSTRAINT "challenge_status_check" CHECK ("status" IN');
  assertStringIncludes(sql, "'pending'");
  assertStringIncludes(sql, "'accepted'");
  assertStringIncludes(sql, "'declined'");
  assertStringIncludes(sql, "'expired'");

  // Check trigger function and initial state check
  assertStringIncludes(sql, 'CREATE OR REPLACE FUNCTION "trg_challenge_status_machine"()');
  assertStringIncludes(sql, "new % must start in initial state % (got %)");

  // Check final state immutability
  assertStringIncludes(sql, "cannot transition from final state % on %");

  // Check timeout guard for 60000ms
  assertStringIncludes(sql, "interval '60000 milliseconds'");
  assertStringIncludes(sql, "% in state % has expired (timeout after %ms)");

  // Check effect generation for ensure
  assertStringIncludes(sql, 'INSERT INTO "audit_log" ("event") VALUES (\'challenge_accepted\') ON CONFLICT ("id") DO NOTHING;');

  // Check trigger registration
  assertStringIncludes(sql, 'CREATE TRIGGER "trg_challenge_status_machine"');
});

Deno.test("mecha machine compiles mutation lifecycle reducer with relational effects", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-reducer"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Expense: {
        table: "expense"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "amount", type: "decimal", precision: 18, scale: 2},
          {name: "bucket", type: "string"},
        ]
      }
    }
    machines: {
      ExpenseReducer: {
        name: "ExpenseReducer"
        entity: "Expense"
        on: {
          insert: {
            effect: {
              op: "accumulate"
              table: "category_month_stat"
              key: ["bucket"]
              values: {
                bucket: {raw: "NEW.bucket"}
                spent: {raw: "NEW.amount"}
                expense_count: 1
              }
            }
          }
        }
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{entity: "Expense"}]
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}).files
`;

  const child = new Deno.Command("cue", {
    args: ["export", "-", "-e", "out", "--out", "json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, true);

  const files = JSON.parse(new TextDecoder().decode(res.stdout));
  const sql = files["services/database/migrations/010_machines.sql"]?.text;
  assertEquals(typeof sql, "string");
  assertStringIncludes(sql, 'CREATE OR REPLACE FUNCTION "trg_expense_ExpenseReducer_reducer"()');
  assertStringIncludes(sql, 'INSERT INTO "category_month_stat" ("bucket", "spent", "expense_count") VALUES (NEW.bucket, NEW.amount, 1) ON CONFLICT ("bucket") DO UPDATE SET "spent" = "category_month_stat"."spent" + EXCLUDED."spent", "expense_count" = "category_month_stat"."expense_count" + EXCLUDED."expense_count";');
  assertStringIncludes(sql, 'CREATE TRIGGER "trg_expense_ExpenseReducer_reducer"');
  assertStringIncludes(sql, 'AFTER INSERT OR UPDATE OR DELETE ON "expense"');
});

Deno.test("mecha machine compiles update with where and upsert with updateValues", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-update"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Expense: {
        table: "expense"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "amount", type: "decimal", precision: 18, scale: 2},
          {name: "bucket", type: "string"},
          {name: "month", type: "string"},
        ]
      }
    }
    machines: {
      ExpenseLedger: {
        name: "ExpenseLedger"
        entity: "Expense"
        on: {
          insert: {
            effect: {
              op: "upsert"
              table: "month_stat"
              key: ["month"]
              values: {
                month: {raw: "NEW.month"}
                spent: {raw: "NEW.amount"}
                expense_count: 1
              }
              updateValues: {
                spent: {raw: "\\"month_stat\\".\\"spent\\" + EXCLUDED.\\"spent\\""}
                expense_count: {raw: "\\"month_stat\\".\\"expense_count\\" + EXCLUDED.\\"expense_count\\""}
              }
            }
          }
          delete: {
            effect: {
              op: "update"
              table: "category_month_stat"
              where: {bucket: {raw: "OLD.bucket"}}
              values: {
                spent: {raw: "GREATEST(0, category_month_stat.spent - OLD.amount)"}
              }
            }
          }
        }
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{entity: "Expense"}]
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}).files
`;

  const child = new Deno.Command("cue", {
    args: ["export", "-", "-e", "out", "--out", "json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, true);

  const files = JSON.parse(new TextDecoder().decode(res.stdout));
  const sql = files["services/database/migrations/010_machines.sql"]?.text;
  assertEquals(typeof sql, "string");
  assertStringIncludes(sql, 'INSERT INTO "month_stat" ("month", "spent", "expense_count") VALUES (NEW.month, NEW.amount, 1) ON CONFLICT ("month") DO UPDATE SET "spent" = "month_stat"."spent" + EXCLUDED."spent", "expense_count" = "month_stat"."expense_count" + EXCLUDED."expense_count";');
  assertStringIncludes(sql, 'UPDATE "category_month_stat" SET "spent" = GREATEST(0, category_month_stat.spent - OLD.amount) WHERE "bucket" = OLD.bucket;');
});


