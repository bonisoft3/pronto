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
      reads: [{table: "challenge", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
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
      reads: [{table: "expense", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
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
      reads: [{table: "expense", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
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

Deno.test("hybrid machines drive cortex sagas and duckstream pipelines", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-hybrid"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Order: {
        table: "orders"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "status", type: "string"},
          {name: "total", type: "decimal", precision: 12, scale: 2},
          {name: "created_at", type: "timestamp"},
        ]
      }
    }
    machines: {
      OrderMachine: {
        name: "OrderMachine"
        entity: "orders"
        field: "status"
        initial: "pending"
        states: {
          pending: {
            on: {
              confirm: {
                target: "confirmed"
                actions: [{
                  effect: {
                    saga: "process_payment"
                    idempotencyKey: "NEW.id"
                    payload: {amount: "NEW.total", store: "main"}
                  }
                }, {
                  effect: {
                    stream: "order_analytics"
                    signal: "refresh"
                  }
                }]
              }
            }
          }
          confirmed: {type: "final"}
        }
      }
    }
    sagas: {
      process_payment: {
        name: "process_payment"
        steps: ["authorize", "capture"]
      }
    }
    duckstreams: {
      order_analytics: {
        name: "order_analytics"
        sql: "SELECT count(*) as total_orders FROM orders WHERE status = 'confirmed'"
        sources: ["orders"]
        sink: "order_metrics"
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{table: "orders", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
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

  // 1. Verify 010_machines.sql contains saga insertion and stream signal
  const machineSql = files["services/database/migrations/010_machines.sql"]?.text;
  assertEquals(typeof machineSql, "string");
  assertStringIncludes(machineSql, 'INSERT INTO "saga" ("id", "name", "idempotency_key", "payload", "status")');
  assertStringIncludes(machineSql, "VALUES (gen_random_uuid()::text, 'process_payment', NEW.id::text, jsonb_build_object('amount', NEW.total, 'store', 'main')::jsonb, 'pending')");
  assertStringIncludes(machineSql, "PERFORM pg_notify('cortex_saga_queue', jsonb_build_object('saga', 'process_payment', 'key', NEW.id::text)::text);");
  assertStringIncludes(machineSql, "PERFORM pg_notify('duckstream_order_analytics', jsonb_build_object('signal', 'refresh', 'table', TG_TABLE_NAME, 'id', NEW.id::text)::text);");

  // 2. Verify 015_sagas.sql migration is emitted
  const sagaSql = files["services/database/migrations/015_sagas.sql"]?.text;
  assertEquals(typeof sagaSql, "string");
  assertStringIncludes(sagaSql, 'CREATE TABLE IF NOT EXISTS "saga"');
  assertStringIncludes(sagaSql, 'UNIQUE ("name", "idempotency_key")');
  assertStringIncludes(sagaSql, 'ALTER TABLE "saga" ENABLE ROW LEVEL SECURITY;');
  assertStringIncludes(sagaSql, 'REVOKE ALL ON "saga" FROM anon, app_user, electric;');

  // 3. Verify duckstream pipeline SQL is emitted
  const streamSql = files["pipelines/duckstream/order_analytics.sql"]?.text;
  assertEquals(typeof streamSql, "string");
  assertStringIncludes(streamSql, "SELECT count(*) as total_orders FROM orders WHERE status = 'confirmed'");
});

Deno.test("a machine referencing an undeclared saga or duckstream is refused at compile time", async () => {
  const cueCode = `
package test
import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-app"
  }
  state: {
    entities: {
      Order: {
        table: "orders"
        durability: "offline"
        fields: [{name: "id", type: "uuid", pk: true}]
      }
    }
    machines: {
      OrderLifecycle: {
        name: "OrderLifecycle"
        entity: "Order"
        on: {
          insert: [
            {
              effect: {
                saga: "undeclared_saga"
              }
            }
          ]
        }
      }
    }
    sagas: {}
    duckstreams: {}
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: {}
    handlers: {}
    design: {}
    flows: {}
  }
}
`;

  const child = new Deno.Command("cue", {
    args: ["vet", "-c", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, false);
  const err = new TextDecoder().decode(res.stderr);
  assertStringIncludes(err, "machine OrderLifecycle references undeclared saga: undeclared_saga");
});

Deno.test("a machine referencing NEW in delete action is refused at compile time", async () => {
  const cueCode = `
package test
import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-app"
  }
  state: {
    entities: {
      Order: {
        table: "orders"
        durability: "offline"
        fields: [{name: "id", type: "uuid", pk: true}]
      }
    }
    machines: {
      OrderLifecycle: {
        name: "OrderLifecycle"
        entity: "Order"
        on: {
          delete: [
            {
              effect: {
                saga: "cleanup_order"
                idempotencyKey: "NEW.id"
              }
            }
          ]
        }
      }
    }
    sagas: {
      cleanup_order: {
        name: "cleanup_order"
      }
    }
    duckstreams: {}
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: {}
    handlers: {}
    design: {}
    flows: {}
  }
}
`;

  const child = new Deno.Command("cue", {
    args: ["vet", "-c", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, false);
  const err = new TextDecoder().decode(res.stderr);
  assertStringIncludes(err, "machine OrderLifecycle references NEW in delete action");
  assertStringIncludes(err, "NEW.id");
});

Deno.test("mecha machine compiles function calls, combined where/rawWhere, and prefixed stream keys", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-composite"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Item: {
        table: "item"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "month", type: "string"},
          {name: "amount", type: "decimal", precision: 12, scale: 2},
        ]
      }
    }
    machines: {
      ItemMachine: {
        name: "ItemMachine"
        entity: "item"
        timing: "AFTER"
        on: {
          insert: [
            {
              effect: {
                call: "pg_advisory_xact_lock"
                args: [{raw: "hashtext('test_lock')::bigint"}]
              }
            },
            {
              effect: {
                op: "update"
                table: "item_summary"
                where: {month: {raw: "NEW.month"}}
                rawWhere: "\\"active\\" = true"
                values: {
                  spent: {raw: "item_summary.spent + NEW.amount"}
                }
              }
            },
            {
              effect: {
                stream: "item_stream"
                key: "NEW.month"
              }
            },
          ]
        }
      }
    }
    duckstreams: {
      item_stream: {
        name: "item_stream"
        sql: "SELECT count(*) FROM item"
        sources: ["item"]
        sink: "item_stat"
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: {}
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
  assertStringIncludes(sql, "PERFORM pg_advisory_xact_lock(hashtext('test_lock')::bigint);");
  assertStringIncludes(sql, 'UPDATE "item_summary" SET "spent" = item_summary.spent + NEW.amount WHERE "month" = NEW.month AND "active" = true;');
  assertStringIncludes(sql, "PERFORM pg_notify('duckstream_item_stream', jsonb_build_object('signal', 'refresh', 'table', TG_TABLE_NAME, 'id', NEW.month::text)::text);");
});



