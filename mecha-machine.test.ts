import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

Deno.test("SQL calls require a named SQL hatch and derive the machine's hatch references", async () => {
  const base = paymentProgram() + `
app: state: machines: PaymentMachine: states: pending: entry: hatch: {name: "billing", call: "bill", args: [{raw: "NEW.id"}]}
`;
  for (const [declaration, error] of [
    ["", "calls undeclared SQL hatch: billing"],
    ['app: capabilities: hatches: billing: {kind: "container", note: "billing"}', "calls hatch billing, which is not SQL"],
  ]) {
    const res = await cue(["export", "-", "-e", "app"], base + declaration);
    assertEquals(res.success, false);
    assertStringIncludes(res.stderr, error);
  }
  const res = await cue(["export", "-", "-e", '{machine: app.state.machines.PaymentMachine, sql: out["services/database/migrations/010_machines.sql"].text}'], base + `
app: capabilities: hatches: billing: {kind: "sql", files: ["services/database/migrations/020_billing.sql"], note: "the billing function owns the write"}
`);
  assertEquals(res.success, true, res.stderr);
  const { machine, sql } = JSON.parse(res.stdout);
  assertEquals(machine.hatches, ["billing"]);
  assertStringIncludes(sql, "PERFORM bill(NEW.id)");
});

Deno.test("state actions run on entry and in exit-transition-entry order", async () => {
  const files = await emitFiles(paymentProgram().replace('pay: "charging"', 'pay: {target: "charging"}') + `
app: state: machines: PaymentMachine: states: {
  pending: {entry: raise: {notify: "trace", payload: "initial"}, exit: raise: {notify: "trace", payload: "exit"}}
  pending: on: pay: {target: "charging", actions: raise: {notify: "trace", payload: "transition"}}
  charging: entry: raise: {notify: "trace", payload: "entry"}
}
`);
  const sql = files["services/database/migrations/010_machines.sql"].text;
  const initial = sql.indexOf("pg_notify('trace', 'initial')");
  const exit = sql.indexOf("pg_notify('trace', 'exit')");
  const transition = sql.indexOf("pg_notify('trace', 'transition')");
  const entry = sql.indexOf("pg_notify('trace', 'entry')");
  assertEquals(initial > 0 && initial < exit && exit < transition && transition < entry, true);
});

Deno.test("signals are raises and SQL calls are hatches, never relational effects", async () => {
  for (const effect of ['{notify: "payments", payload: "changed"}', '{stream: "payments"}', '{call: "bill"}']) {
    const res = await cue(["export", "-", "-e", "app"], paymentProgram() + `\napp: state: machines: PaymentMachine: states: pending: entry: effect: ${effect}`);
    assertEquals(res.success, false);
    assertStringIncludes(res.stderr, "effect");
  }
  const files = await emitFiles(paymentProgram().replace('onDone: "settled"', 'onDone: {target: "settled", actions: {raise: [{notify: "payments", payload: "done"}, {notify: "audit", payload: "paid"}]}}'));
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, "pg_notify('payments', 'done')");
  assertStringIncludes(sql, "pg_notify('audit', 'paid')");
});

Deno.test("a raw pipeline requires its own hatch rationale", async () => {
  const base = paymentProgram() + '\napp: state: pipelines: authored: {raw: true, from: "Payment", to: "Payment", group: "authored"}';
  for (const extra of ["", '\napp: state: pipelines: authored: note: ""']) {
    const res = await cue(["export", "-", "-e", "app"], base + extra);
    assertEquals(res.success, false);
    assertStringIncludes(res.stderr, "note");
  }
  const res = await cue(["export", "-", "-e", "app.state.pipelines.authored"], base + '\napp: state: pipelines: authored: note: "the authored sink decides delivery"');
  assertEquals(res.success, true, res.stderr);
  assertEquals(JSON.parse(res.stdout).delivery, "unspecified");
});

Deno.test("a machine cannot combine a statechart with lifecycle actions the SQL would discard", async () => {
  for (const event of ["insert", "update", "delete"]) {
    const res = await cue(["export", "-", "-e", "out"], paymentProgram() + `
app: state: machines: PaymentMachine: on: ${event}: raise: {notify: "payments", payload: "TG_OP"}
`);
    assertEquals(res.success, false);
    assertStringIncludes(res.stderr, "machine PaymentMachine combines states and lifecycle handlers: declare separate machines");
  }
});

// A Challenge statechart whose `accept` transition performs one relational
// effect of the given op on audit_log.
function challengeProgram(op: string): string {
  return `
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
                    op: "${op}"
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

Deno.test("mecha machine compiles statechart into PostgreSQL 010_machines.sql", async () => {
  const files = await emitFiles(challengeProgram("ensure"));
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

  // A timeout arms the ticker rather than depending on another client write.
  assertStringIncludes(sql, "interval '60000 milliseconds'");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS public.machine_timer_tick");
  assertStringIncludes(sql, "timer_delay = '60000'");

  // Check effect generation for ensure
  assertStringIncludes(sql, 'INSERT INTO "audit_log" ("event") VALUES (\'challenge_accepted\') ON CONFLICT ("id") DO NOTHING;');

  // Check trigger registration
  assertStringIncludes(sql, 'CREATE TRIGGER "trg_challenge_status_machine"');
});

Deno.test("a strict create emits a bare INSERT, and an op outside #RelationalOp is refused: the word is the terminal's, matched by spelling in emit.cue", async () => {
  const files = await emitFiles(challengeProgram("create"));
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, `INSERT INTO "audit_log" ("event") VALUES ('challenge_accepted');`);
  assertEquals(sql.includes("ON CONFLICT"), false);
  const refused = await cue(["export", "-", "-e", "out", "--out", "json"], challengeProgram("insert"));
  assertEquals(refused.success, false);
  // The refusal is the op's: cue names the field and the word, so a fixture
  // that fails elsewhere does not pass as a refused op.
  assertStringIncludes(refused.stderr, 'effect.op: conflicting values "create" and "insert"');
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
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

async function refusal(code: string): Promise<string> {
  const res = await cue(["vet", "-c", "-"], code);
  assertEquals(res.success, false);
  return res.stderr;
}

Deno.test("entering an invoking state claims the ledger and enqueues in the transition's commit", async () => {
  const files = await emitFiles(paymentProgram());
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, `INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")`);
  assertStringIncludes(sql, `VALUES ('charge:' || NEW."id"::text, 'charge', jsonb_build_object('id', NEW."id"), jsonb_build_object('amount', NEW."total", 'currency', 'BRL'))`);
  // A second claim of a performed key is refused, not skipped.
  assertStringIncludes(sql, `IF NOT FOUND THEN\n          RAISE EXCEPTION 'external effect % was already performed: entering charging again needs a new key', 'charge:' || NEW."id"::text USING ERRCODE = 'unique_violation';`);
  assertStringIncludes(sql, `PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'charge:' || NEW."id"::text), job_key => 'charge:' || NEW."id"::text, max_attempts => 30);`);
  // And the ticker's one-shot row re-armed, so a cluster asleep is woken for the job.
  // The re-arm writes only a row not yet armed and waits on no lock, so
  // claims never queue on the one row (emit.cue).
  assertStringIncludes(sql, `UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL\n         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL\n           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);`);
  // A key is a field's text, spelled the same in every session.
  assertStringIncludes(sql, `SET search_path = public, pg_catalog\nSET TimeZone = 'UTC'\nSET DateStyle = 'ISO, YMD' AS $$`);
  // Leaving is admitted only by the ledger's recorded outcome, keyed on the old row.
  assertStringIncludes(sql, `SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'charge:' || OLD."id"::text;`);
  assertStringIncludes(sql, `NEW."failure" := outcome->>'kind';`);
  assertStringIncludes(sql, "DECLARE\n  outcome jsonb;");

  // The ledger is mecha's (services/airlock/airlock.sql), placed by the cluster.
  assertEquals(Object.keys(files).filter((f) => f.includes("migrations/015_")), []);
});

Deno.test("the airlock is handed each effect's state, outcome targets, sink and handler", async () => {
  const files = await emitFiles(paymentProgram().replace("idempotent: true", "idempotent: false"));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data, {
    effects: {
      charge: {
        table: "payment",
        field: "status",
        state: "charging",
        onDone: "settled",
        onError: "failed",
        row: ["id"],
        idempotent: false,
        reentry: "reconcile",
        attempts: 5,
        handler: "effects/charge.js",
      },
    },
  });
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/dapr/charge.yaml"])).data, {
    apiVersion: "dapr.io/v1alpha1",
    kind: "Component",
    metadata: { name: "charge" },
    spec: {
      type: "bindings.http",
      version: "v1",
      metadata: [{ name: "url", value: "https://api.acquirer.example" }, { name: "errorIfNot2XX", value: "false" }],
    },
  });
  assertEquals(JSON.parse(JSON.stringify(files["effects/charge.js"])), { format: "jessie", src: "effects/charge.js" });
});

Deno.test("secrets are declared by their environment variables, reaching the manifest, never a value", async () => {
  const files = await emitFiles(paymentProgram({ effect: `secrets: ["PAY_SIGNING_KEY"]` }));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.effects.charge.secrets, ["PAY_SIGNING_KEY"]);
  const err = await refusal(paymentProgram({ effect: `secrets: ["pay-key"]` }));
  assertStringIncludes(err, "secrets");
});

// The fixture's sink, swapped for a bridge declared beside the effects.
const bridged = (bridges: string, sink = `sink: {bridge: "mail", idempotent: false}\n      reentry: "unknown"`) =>
  paymentProgram()
    .replace('sink: {origin: "https://api.acquirer.example", idempotent: true}', sink)
    .replace("effects: charge:", `${bridges}\n    effects: charge:`) + `\napp: capabilities: hatches: smtp: {kind: "container", note: "SMTP transport outside confinement"}\n_cluster: surface: targets: smtp: {cmd: builtin: null, activate: "", dockerfile: from: name: "bridge-fixture:1", compose: {}}\n`;
const MAIL_BRIDGE = `bridges: mail: {container: "smtp", port: 8080}`;

Deno.test("a sink's credential is a header the airlock adds from a declared secret, required of the environment and handed to no handler", async () => {
  const program = paymentProgram({ effect: `secrets: ["ACQUIRER_WEBHOOK_KEY"]` }).replace(
    `sink: {origin: "https://api.acquirer.example", idempotent: true}`,
    `sink: {origin: "https://api.acquirer.example", idempotent: true, credential: {scheme: "Bearer", secret: "ACQUIRER_KEY"}}`,
  );
  const files = await emitFiles(program);
  const manifest = JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.effects.charge;
  assertEquals(manifest.credential, { header: "Authorization", scheme: "Bearer", secret: "ACQUIRER_KEY" });
  assertEquals(manifest.secrets, ["ACQUIRER_WEBHOOK_KEY"]);
  const env = await cue(["export", "-", "-e", "_cluster.surface.targets.airlock.compose.environment", "--out", "json"], program);
  assertEquals(env.success, true, env.stderr);
  assertEquals(JSON.parse(env.stdout).ACQUIRER_KEY, "${ACQUIRER_KEY:?ACQUIRER_KEY is required: an effect declares it}");
  assertStringIncludes(await refusal(program.replace('secret: "ACQUIRER_KEY"', 'secret: "acquirer-key"')), "credential");
  // A header daprd forwards starts uppercase, and is none the host or HTTP sets.
  for (const header of ["x-api-key", "Idempotency-Key", "content-type", "Host"]) {
    assertStringIncludes(await refusal(program.replace('credential: {scheme: "Bearer", secret: "ACQUIRER_KEY"}', `credential: {header: "${header}", secret: "ACQUIRER_KEY"}`)), "header");
  }
  // The credential is the airlock's alone, never also the handler's.
  assertStringIncludes(await refusal(program.replace('secrets: ["ACQUIRER_WEBHOOK_KEY"]', 'secrets: ["ACQUIRER_KEY"]')), "effect charge lists its credential's ACQUIRER_KEY among the handler's secrets");
  // Nor a variable the cluster's own services read.
  assertStringIncludes(await refusal(program.replace('secret: "ACQUIRER_KEY"', 'secret: "SERVICE_JWT"')), "credential");
  assertStringIncludes(await refusal(program.replace('secrets: ["ACQUIRER_WEBHOOK_KEY"]', 'secrets: ["POSTGRES_PASSWORD"]')), "secrets");
  // A bridge takes no credential: past it nothing is the platform's to carry.
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE, `sink: {bridge: "mail", idempotent: false, credential: {secret: "K"}}\n      reentry: "unknown"`)), "credential");
});

Deno.test("the level is derived and never authored: the entity's from its durability, the machine's from its invoke", async () => {
  const program = paymentProgram();
  const levels = await cue(["export", "-", "-e", "{entity: app.state.entities.Payment.level, machine: app.state.machines.PaymentMachine.level}", "--out", "json"], program);
  assertEquals(levels.success, true, levels.stderr);
  assertEquals(JSON.parse(levels.stdout), { entity: "replicated", machine: "external" });
  // An authored level is refused: it is the durability's to say.
  assertStringIncludes(await refusal(program.replace('durability: "server"', 'durability: "server"\n        level: "ephemeral"')), "level");
});

Deno.test("an effect's cluster keeps the wake's names, and the service role the ticker writes as", async () => {
  const program = paymentProgram();
  assertStringIncludes(await refusal(paymentProgram({ entity: `Wake: {table: "airlock_wake", durability: "server", fields: [{name: "id", type: "uuid", pk: true}]}` })), "entity Wake takes table airlock_wake, which the airlock's wake keeps");
  assertStringIncludes(await refusal(paymentProgram({ entity: `Sched: {table: "schedule", durability: "server", fields: [{name: "id", type: "uuid", pk: true}]}` })), "entity Sched takes table schedule, which the airlock's wake keeps");
  assertStringIncludes(
    await refusal(program.replace("machines: PaymentMachine:", `schedules: airlock: {cron: "0 3 * * *", emits: {entity: "Payment", values: status: "pending"}}\n    machines: PaymentMachine:`)),
    "schedule airlock is the airlock's own wake",
  );
  // No auth plane, yet the service role, its bypass and its grants: the
  // ticker's writes land as it.
  const roles = (await emitFiles(program))["services/database/migrations/001_roles.sql"].text;
  assertStringIncludes(roles, "CREATE ROLE service NOLOGIN;");
  assertStringIncludes(roles, "ALTER ROLE service BYPASSRLS;");
  assertEquals(roles.includes("app_user"), false);
  assertStringIncludes((await emitFiles(program))["services/database/migrations/002_grants.sql"].text, "ON ALL TABLES IN SCHEMA public TO anon, service;");
});

// The schema states electric's attributes and never its password: on
// Kubernetes the operator sets the password from a secret, and a roles
// migration that set one would overwrite it whenever it ran.
Deno.test("the roles migration leaves electric's password to the deployment", async () => {
  const roles = (await emitFiles(paymentProgram()))["services/database/migrations/001_roles.sql"].text;
  assertStringIncludes(roles, "ALTER ROLE electric BYPASSRLS REPLICATION LOGIN;");
  assertEquals(/PASSWORD/i.test(roles), false);
});

Deno.test("an effect reached through a bridge gets the bridge's in-cluster endpoint", async () => {
  const files = await emitFiles(bridged(MAIL_BRIDGE));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/dapr/charge.yaml"])).data.spec.metadata[0], { name: "url", value: "http://smtp:8080" });
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.effects.charge.reentry, "unknown");
});

Deno.test("a bridged effect states what a repeat costs: neither idempotent nor reconciled", async () => {
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE, `sink: {bridge: "mail", idempotent: true}`)), "past a bridge nothing is the platform's to promise");
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE, `sink: {bridge: "mail", idempotent: false}`)), "a bridge answers no query");
  const files = await emitFiles(bridged(MAIL_BRIDGE, `sink: {bridge: "mail", idempotent: false}\n      reentry: "repeat"`));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.effects.charge.reentry, "repeat");
});

Deno.test("a bridge no effect reaches, or an effect reaching an undeclared bridge, is refused", async () => {
  assertStringIncludes(await refusal(bridged("", `sink: {bridge: "smtp", idempotent: false}`)), "effect charge reaches undeclared bridge: smtp");
  assertStringIncludes(
    await refusal(bridged(MAIL_BRIDGE, 'sink: {origin: "https://api.acquirer.example", idempotent: true}')),
    "bridge mail is reached by no effect",
  );
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE.replace('container: "smtp"', 'container: "missing"'))), "undeclared container hatch: missing");
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE).replace('kind: "container"', 'kind: "sql", files: ["m.sql"]')), "which is not a container");
  assertStringIncludes(await refusal(bridged(MAIL_BRIDGE.replace("8080", "0"))), "port");
});

Deno.test("an effect declares its handler's endowments, as an omnishell module declares Intl", async () => {
  const files = await emitFiles(paymentProgram({ effect: `endowments: ["Crypto", "TextEncoder"]` }));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/effects.json"])).data.effects.charge.endowments, ["Crypto", "TextEncoder"]);
  assertStringIncludes(await refusal(paymentProgram({ effect: `endowments: ["Intl"]` })), "endowments");
});

Deno.test("an effect is invoked by exactly one state", async () => {
  const twice = await refusal(paymentProgram({ machine: `
        pending: on: pay: "charging"
        charging: invoke: {src: "charge", onDone: "settled", onError: "again"}
        again: invoke: {src: "charge", onDone: "settled", onError: "failed"}
        settled: type: "final"
        failed: type: "final"`,
  }));
  assertStringIncludes(twice, "effect charge is invoked by 2 states: exactly one invokes it");
  const never = await refusal(paymentProgram({ machine: `
        pending: on: pay: "settled"
        settled: type: "final"`,
  }));
  assertStringIncludes(never, "effect charge is invoked by no state: its entity is its invoking machine's, so it has none");
});

Deno.test("an effect's name is a DNS label, as its Dapr endpoint's must be", async () => {
  const err = await refusal(paymentProgram().replaceAll("charge", "charge_card"));
  assertStringIncludes(err, "charge_card");
});

Deno.test("an initial state that invokes claims on insert", async () => {
  const files = await emitFiles(paymentProgram({ machine: `
        charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
        settled: type: "final"
        failed: type: "final"`,
  }).replace(`initial: "pending"`, `initial: "charging"`));
  const sql = files["services/database/migrations/010_machines.sql"].text;
  const insertPath = sql.slice(sql.indexOf("IF TG_OP = 'INSERT' THEN"), sql.indexOf("IF TG_OP = 'UPDATE' THEN\n"));
  assertStringIncludes(insertPath, `INSERT INTO "airlock"."external_effect_ledger"`);
});

Deno.test("a key of several fields is JSON-encoded, so a ':' in a value makes no two instances one, and the queue holds more than the attempts", async () => {
  const files = await emitFiles(paymentProgram({ effect: `key: ["id", "failure"]\n      attempts: 2` }));
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, `'charge:' || jsonb_build_array(NEW."id"::text, NEW."failure"::text)::text`);
  assertStringIncludes(sql, "max_attempts => 27");
});

// An invoking state is left only by its outcome; a program whose outcome could
// never be delivered would hold the row there while the airlock retried.
Deno.test("an outcome that could never be delivered is refused", async () => {
  const machine = (charging: string) => `
        pending: on: pay: "charging"
        charging: ${charging}
        settled: type: "final"
        failed: type: "final"`;
  assertStringIncludes(await refusal(paymentProgram({ machine: machine(`{type: "final", invoke: {src: "charge", onDone: "settled", onError: "failed"}}`) })), "is final: no outcome could leave it");
  assertStringIncludes(await refusal(paymentProgram({ machine: machine(`invoke: {src: "charge", onDone: "setled", onError: "failed"}`) })), "an outcome target that is no state: setled");
  assertStringIncludes(await refusal(paymentProgram({ machine: machine(`invoke: {src: "charge", onDone: "settled", onError: "charging"}`) })), "an outcome targeting itself");
  assertStringIncludes(
    await refusal(paymentProgram({ machine: machine(`invoke: {src: "charge", onDone: "failed", onError: {target: "failed", actions: [{assign: {failure: "x"}}]}}`) })),
    "share target failed and carry actions",
  );
  assertStringIncludes(
    await refusal(paymentProgram({ machine: machine(`invoke: {src: "charge", onDone: "settled", onError: {target: "failed", actions: [{reject: "no"}]}}`) })),
    "an outcome's actions reject",
  );
  for (const action of ['charging: exit: reject: "no"', 'settled: entry: reject: "no"']) {
    assertStringIncludes(await refusal(paymentProgram() + `\napp: state: machines: PaymentMachine: states: ${action}`), "an outcome's entry or exit actions reject");
  }
  // One target for both arrows, with no actions, is a plain join.
  const files = await emitFiles(paymentProgram({ machine: machine(`invoke: {src: "charge", onDone: "failed", onError: "failed"}`) }));
  assertEquals(typeof files["services/database/migrations/010_machines.sql"].text, "string");
});

Deno.test("an input reads a field the entity has, quoted", async () => {
  assertStringIncludes(await refusal(paymentProgram({ effect: `input: {amt: "NEW.totl"}` })), "input amt reads NEW.totl, which is not a field of Payment");
  const files = await emitFiles(paymentProgram({ effect: `input: {"it's": "NEW.total"}` }));
  assertStringIncludes(files["services/database/migrations/010_machines.sql"].text, `'it''s', NEW."total"))`);
});

Deno.test("a row in an invoking state keeps its key and is not deleted until its outcome", async () => {
  const sql = (await emitFiles(paymentProgram({ effect: `key: ["id", "failure"]` })))["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, `IF TG_OP = 'DELETE' THEN\n    IF OLD."status" IN ('charging') THEN\n      RAISE EXCEPTION '% in % awaits an outcome and is not deleted'`);
  assertStringIncludes(sql, `IF TG_OP = 'UPDATE' AND OLD."status" = 'charging' AND (OLD."failure" IS DISTINCT FROM NEW."failure" OR OLD."id" IS DISTINCT FROM NEW."id") THEN\n    RAISE EXCEPTION '% in charging keeps its key until the outcome of %'`);
  assertStringIncludes(sql, `BEFORE INSERT OR UPDATE OR DELETE ON "payment"`);
  // A machine with no invoke keeps its trigger as it was.
  const plain = (await emitFiles(paymentProgram({ machine: `
        pending: on: pay: "settled"
        settled: type: "final"` }).replace(/effects: charge: \{[\s\S]*?\n    \}\n/, "")))["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(plain, `BEFORE INSERT OR UPDATE ON "payment"`);
  assertEquals(plain.includes("TG_OP = 'DELETE'"), false);
});

Deno.test("an invoke naming no declared effect is refused", async () => {
  const err = await refusal(paymentProgram().replace(`src: "charge"`, `src: "refund"`));
  assertStringIncludes(err, "machine PaymentMachine state charging invokes undeclared effect: refund");
});

Deno.test("an invoking state with any exit but its outcome is refused", async () => {
  const err = await refusal(paymentProgram({ machine: `
        pending: on: pay: "charging"
        charging: {
          invoke: {src: "charge", onDone: "settled", onError: "failed"}
          on: cancel: "failed"
        }
        settled: type: "final"
        failed: type: "final"`,
  }));
  assertStringIncludes(err, "machine PaymentMachine state charging invokes charge and declares on or after: only the effect's outcome leaves it");
});

// The effect's entity is read off the invoking machine (#App's
// _effectEntityNames), so a declaration has no second place to state it: the
// closed #ExternalEffect refuses the field, agreeing or not.
Deno.test("an effect's entity is the invoking machine's, and an authored one is a field the effect lacks", async () => {
  const agreeing = await refusal(paymentProgram({ effect: `entity: "Payment"` }));
  assertStringIncludes(agreeing, "app.state.effects.charge.entity: field not allowed");
});

// One effect reads NEW and keys on fields of one row; two machines over two
// entities would hand it two shapes under one ledger prefix.
Deno.test("an effect invoked by machines of two entities is refused", async () => {
  const order = `machines: OrderMachine: {
      name: "OrderMachine"
      entity: "Order"
      field: "status"
      initial: "open"
      states: {
        open: on: pay: "paying"
        paying: invoke: {src: "charge", onDone: "paid", onError: "open"}
        paid: type: "final"
      }
    }
    `;
  const err = await refusal(paymentProgram({
    entity: `Order: {table: "orders", durability: "server", fields: [{name: "id", type: "uuid", pk: true}, {name: "status", type: "string"}]}`,
  }).replace("machines: PaymentMachine:", `${order}machines: PaymentMachine:`));
  assertStringIncludes(err, "effect charge is invoked by machines of 2 entities (Order, Payment): its NEW reads and its key need one row");
});

// The entity is the machine's fault, not its invoke's: a machine that invokes
// nothing names it too, and emit.cue would index an empty list for its table.
Deno.test("a machine naming an undeclared entity is refused, whether or not it invokes", async () => {
  const invoking = await refusal(paymentProgram().replace(`entity: "Payment"\n      field: "status"`, `entity: "Invoice"\n      field: "status"`));
  assertStringIncludes(invoking, "machine PaymentMachine names undeclared entity: Invoice");
  const plain = await refusal(
    paymentProgram({ machine: `pending: on: pay: "settled"\n        settled: type: "final"` })
      .replace(`entity: "Payment"\n      field: "status"`, `entity: "Invoice"\n      field: "status"`)
      .replace(/    effects: charge: \{[\s\S]*?\n    \}\n/, ""),
  );
  assertStringIncludes(plain, "machine PaymentMachine names undeclared entity: Invoice");
});

Deno.test("an effect of an entity the cluster does not hold is refused", async () => {
  const err = await refusal(paymentProgram().replace(`durability: "server"`, `durability: "tab"`));
  assertStringIncludes(err, "effect charge is of Payment, whose rows do not live in the cluster");
});

Deno.test("an effect keyed on a field the entity lacks is refused", async () => {
  const err = await refusal(paymentProgram({ effect: `key: ["intent"]` }));
  assertStringIncludes(err, "effect charge keys on intent, which is not a field of Payment");
});

Deno.test("reentry is declared only for a sink that is not idempotent, as a word", async () => {
  const onIdempotent = await refusal(paymentProgram({ effect: `reentry: "unknown"` }));
  assertStringIncludes(onIdempotent, "reentry");
  assertStringIncludes(onIdempotent, "field not allowed");
  // The reason a duplicate is acceptable is the effect's note, not a field of its own.
  const repeatWithReason = await refusal(
    paymentProgram({ effect: `reentry: {repeat: "a second mail is a nuisance"}` }).replace("idempotent: true", "idempotent: false"),
  );
  assertStringIncludes(repeatWithReason, "reentry");
  const files = await emitFiles(paymentProgram().replace("idempotent: true", "idempotent: false"));
  assertEquals(typeof files["services/database/migrations/010_machines.sql"].text, "string");
});

// Idempotency and the cost of a repeat are claims about a peer the compiler
// cannot check, so every effect carries the judgment in prose.
Deno.test("an effect without a note is refused", async () => {
  const err = await refusal(paymentProgram().replace(`      note: "the acquirer deduplicates on Idempotency-Key"\n`, ""));
  assertStringIncludes(err, "note");
  // An empty note is the field present and the judgment absent: `repeat` with
  // nothing said would admit a duplicate for no stated reason.
  const empty = await refusal(paymentProgram().replace(`note: "the acquirer deduplicates on Idempotency-Key"`, `note: ""`));
  assertStringIncludes(empty, `app.state.effects.charge.note: invalid value "" (out of bound !="")`);
  assertEquals(typeof (await emitFiles(paymentProgram()))["services/airlock/effects.json"], "object");
});

// The airlock's daprd sits on the cluster's own network: an origin naming a
// service there by its single label, or any address, would be a door inward,
// and userinfo would put a credential where the binding's secrets belong.
Deno.test("a sink origin is an https origin naming a DNS host, and nothing more", async () => {
  for (const origin of [
    "http://api.acquirer.example", "https://api.acquirer.example/v1/charges", "https://database", "https://database:5432",
    "https://10.0.0.7", "https://169.254.169.254", "https://[::1]", "https://user:pw@api.acquirer.example",
  ]) {
    const err = await refusal(paymentProgram().replace("https://api.acquirer.example", origin));
    assertStringIncludes(err, "origin");
  }
});

Deno.test("a machine signals a duckstream pipeline", async () => {
  const files = await emitFiles(paymentProgram({ machine: `
        pending: on: pay: {
          target: "charging"
          actions: [{raise: {stream: "payment_analytics", signal: "refresh"}}]
        }
        charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
        settled: type: "final"
        failed: type: "final"`,
  }).replace("effects: charge:", `duckstreams: payment_analytics: {
      name: "payment_analytics"
      sql: "SELECT count(*) AS settled FROM payment WHERE status = 'settled'"
      sources: ["payment"]
      sink: "payment_metrics"
    }
    effects: charge:`));
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, "PERFORM pg_notify('duckstream_payment_analytics', jsonb_build_object('signal', 'refresh', 'table', TG_TABLE_NAME, 'id', NEW.id::text)::text);");
  assertStringIncludes(files["pipelines/duckstream/payment_analytics.sql"].text, "SELECT count(*) AS settled FROM payment WHERE status = 'settled'");
});

Deno.test("a machine referencing an undeclared duckstream is refused at compile time", async () => {
  const err = await refusal(paymentProgram({ machine: `
        pending: on: pay: {
          target: "charging"
          actions: [{raise: {stream: "undeclared_stream"}}]
        }
        charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
        settled: type: "final"
        failed: type: "final"`,
  }));
  assertStringIncludes(err, "machine PaymentMachine references undeclared duckstream: undeclared_stream");
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
              raise: {
                stream: "cleanup_order"
                key: "NEW.id"
              }
            }
          ]
        }
      }
    }
    duckstreams: {
      cleanup_order: {
        name: "cleanup_order"
        sql: "SELECT 1"
        sources: ["orders"]
        sink: "order_metrics"
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
              hatch: {
                name: "locking"
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
              raise: {
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
  capabilities: {hatches: {locking: {kind: "sql", files: ["services/database/migrations/020_locking.sql"], note: "serializes writers to the summary"}}, vendored: {}}
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
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
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




Deno.test("the machine supplies the column default and check so an omitted status starts legally", async () => {
  const files = await emitFiles(challengeProgram("ensure"));
  const sql = files["services/database/migrations/005_create_tables.sql"].text;
  assertStringIncludes(sql, `"status" text DEFAULT 'pending' NOT NULL CHECK ("status" IN (`);
  for (const state of ["pending", "accepted", "declined", "expired"]) assertStringIncludes(sql, `'${state}'`);
});

Deno.test("a machine refuses a conflicting default, a closed enum missing a state, and a seed outside its states", async () => {
  const base = challengeProgram("ensure");
  for (const [source, sentence] of [
    [base.replace('{name: "status", type: "string"}', `{name: "status", type: "string", default: "'accepted'"}`), "disagrees with Challenge.status default"],
    [base.replace('durability: "server"', 'durability: "server"\n cel: enums: status: ["pending"]'), "is not admitted by Challenge.status cel enum"],
    [base.replace('durability: "server"', 'durability: "server"\n seed: [{status: "lost"}]'), "value lost is not a state"],
  ]) {
    const res = await cue(["export", "-", "-e", "app", "--out", "json"], source);
    assertEquals(res.success, false);
    assertStringIncludes(res.stderr, sentence);
  }
});

Deno.test("a matching default and CEL check remain the column's one declared constraint", async () => {
  const source = challengeProgram("ensure").replace('{name: "status", type: "string"}', `{name: "status", type: "string", default: "'pending'", cel: "this in ['pending', 'accepted', 'declined', 'expired']"}`)
    .replace('durability: "server"', `durability: "server"
      cel: {checks: status: "status IN ('pending', 'accepted', 'declined', 'expired')", enums: status: ["pending", "accepted", "declined", "expired"]}
      seed: [{status: "pending"}]`);
  const files = await emitFiles(source);
  const line = files["services/database/migrations/005_create_tables.sql"].text.split("\n").find(l => l.includes('"status"'))!;
  assertEquals(line.match(/DEFAULT/g)?.length, 1);
  assertEquals(line.match(/CHECK/g)?.length, 1);
});

Deno.test("machine transitions cannot occupy generated or retired columns", async () => {
  for (const [attributes, sentence] of [
    [`generated: "'pending'"`, "is generated and cannot hold transitions"],
    ["retired: true", "is retired and cannot hold transitions"],
  ]) {
    const source = challengeProgram("ensure").replace('{name: "status", type: "string"}', `{name: "status", type: "string", ${attributes}}`);
    const result = await cue(["export", "-", "-e", "app", "--out", "json"], source);
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "machine ChallengeMachine field Challenge.status");
    assertStringIncludes(result.stderr, sentence);
  }
});

Deno.test("shell schema sends typed literal defaults and leaves SQL expressions with the store", async () => {
  const source = challengeProgram("ensure").replace('{name: "created_at", type: "timestamp"}', `
    {name: "created_at", type: "timestamp", default: "now()"},
    {name: "label", type: "string", default: "'can''t'"},
    {name: "empty", type: "string", default: "''"},
    {name: "count", type: "int32", default: "-12"},
    {name: "ratio", type: "double", default: "+1.5e2"},
    {name: "large", type: "int64", default: "9007199254740993"},
    {name: "legacy_large", type: "bigint", default: "+9007199254740993"},
    {name: "precise", type: "decimal", precision: 38, scale: 18, default: "12345678901234567890.123456789012345678"},
    {name: "exponent", type: "decimal", precision: 38, scale: 20, default: "1.2300e-18"},
    {name: "integer_exponent", type: "int64", default: "1.20e2"},
    {name: "rounded_integer", type: "int64", default: "1.5"},
    {name: "quoted_false", type: "bool", default: "'false'"},
    {name: "quoted_json", type: "json", default: #"'{"n":1}'"#},
    {name: "quoted_bytes", type: "bytes", default: "'abcd'"},
    {name: "zero", type: "decimal", precision: 3, scale: 2, default: "-0.00"},
    {name: "yes", type: "bool", default: "TRUE"},
    {name: "no", type: "bool", default: "false"},
    {name: "absent", type: "string", required: false, default: "NULL"},
    {name: "expression", type: "uuid", default: "gen_random_uuid()"},
    {name: "quoted_expr", type: "string", default: "'a' || 'b'"}`);
  const result = await cue(["export", "-", "-e", 'out["shell/shell.yaml"].data.schema.challenge.fields', "--out", "json"], source);
  assertEquals(result.success, true, result.stderr);
  const fields = JSON.parse(result.stdout) as {name: string; default?: unknown; defaulted?: boolean}[];
  assertEquals(Object.fromEntries(fields.filter(f => Object.hasOwn(f, "default")).map(f => [f.name, f.default])), {
    status: "pending", label: "can't", empty: "", count: -12, ratio: 150, yes: true, no: false, absent: null,
    large: "9007199254740993", legacy_large: "9007199254740993", precise: "12345678901234567890.123456789012345678",
    exponent: "0.00000000000000000123", integer_exponent: "120", zero: "0",
  });
  assertEquals(fields.filter(f => f.name !== "id").every(f => f.defaulted === true), true);
  assertEquals(Object.hasOwn(fields.find(f => f.name === "id")!, "defaulted"), false);
});

Deno.test("omitting SQL expression values preserves the markup gate for pending discriminants", async () => {
  const { screenFindings } = await import("../omnishell/check-markup.ts");
  const source = challengeProgram("ensure").replace('{name: "created_at", type: "timestamp"}',
    '{name: "kind", type: "string", default: "choose_kind()", cel: "this in [\'note\', \'link\']"}') +
    '\napp: state: entities: Challenge: cel: enums: kind: ["note", "link"]\n';
  const result = await cue(["export", "-", "-e", 'out["shell/shell.yaml"].data.schema', "--out", "json"], source);
  assertEquals(result.success, true, result.stderr);
  const schema = JSON.parse(result.stdout) as Parameters<typeof screenFindings>[2];
  const kind = schema.challenge.fields.find(f => f.name === "kind")!;
  assertEquals(kind.defaulted, true);
  assertEquals(Object.hasOwn(kind, "default"), false);
  assertEquals(kind.enum, ["note", "link"]);
  const html = '<ul data-live="challenge">' +
    '<template data-item data-when="kind=eq.note"><li>Note</li></template>' +
    '<template data-item data-when="kind=eq.link"><li>Link</li></template>';
  const findings = screenFindings("shell/screens/board.html", html + '</ul>', schema, new Set(), []);
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0].message, '"kind" is DB-defaulted');
  assertEquals(screenFindings("shell/screens/board.html",
    html + '<template data-item><li>Pending</li></template></ul>', schema, new Set(), []), []);
});

Deno.test("Mecha actions qualify private tables and order locks before writes", async () => {
  const files = await emitFiles(paymentProgram() + `
app: state: machines: PaymentMachine: states: pending: entry: {
  lock: {schema: "private", table: "account", key: "id", values: [{raw: "NEW.id"}]}
  effect: {op: "update", schema: "private", table: "account", values: {active: true}, rawWhere: "id = NEW.id"}
}
`);
  const sql = files["services/database/migrations/010_machines.sql"].text;
  const lock = 'FROM "private"."account" WHERE "id" IN (NEW.id) ORDER BY "id" FOR UPDATE;';
  const write = 'UPDATE "private"."account" SET "active" = true WHERE id = NEW.id;';
  assertStringIncludes(sql, lock);
  assertStringIncludes(sql, write);
  assertEquals(sql.indexOf(lock) < sql.indexOf(write), true);
});

Deno.test("bounded Mecha machines share SQL hatch admission and refuse trigger-only actions", async () => {
  const machine = `
app: state: hybrids: bounded: {rules: "bounded.js", machine: {
  config: {id: "bounded", initial: "ready", states: ready: on: run: {actions: "bill"}}
  setup: {
    version: 1
    types: {
      context: {type: "object", fields: {}}
      view: {type: "object", fields: {}}
      events: run: {tier: "mecha", payload: {type: "object", fields: {}}}
    }
    actions: bill: [{hatch: {name: "billing", call: "bill"}}]
  }
}}
`;
  const result = await cue(["export", "-", "-e", "app"], paymentProgram() + machine);
  assertEquals(result.success, false);
  assertStringIncludes(result.stderr, "calls undeclared SQL hatch: billing");
  const declared = paymentProgram() + machine + `
app: capabilities: hatches: billing: {kind: "sql", files: ["billing.sql"], note: "billing operation"}
`;
  const valid = await cue(["export", "-", "-e", "app"], declared);
  assertEquals(valid.success, true, valid.stderr);
  for (const action of ['assign: {phase: "ready"}', 'lock: {table: "account", key: "id", values: [1]}', 'raise: {stream: "scores"}']) {
    const invalid = await cue(["export", "-", "-e", "app"], declared.replace('hatch: {name: "billing", call: "bill"}', action));
    assertEquals(invalid.success, false, action);
  }
});

Deno.test("a Mecha machine refuses the XState it cannot run instead of misreading it", async () => {
  // An event's transition list compiled to an unguarded no-op, and an invoke
  // was dropped: both read as valid machines doing something else.
  const machine = (state: string, root = "") => `
app: state: hybrids: bounded: {rules: "bounded.js", machine: {
  config: {id: "bounded", initial: "ready", ${root} states: {ready: ${state}, done: type: "final"}}
  setup: {
    version: 1
    types: {
      context: {type: "object", fields: {}}
      view: {type: "object", fields: {}}
      events: run: {tier: "omnishell", payload: {type: "object", fields: {}}}
    }
  }
}}
`;
  for (const [state, reason] of [
    ['{on: run: [{target: "done", guard: "mayRun"}, {target: "ready"}]}', "an event names one transition"],
    ["{on: run: []}", "an event names one transition"],
    ['{invoke: {src: "child"}, on: run: "done"}', "a Mecha machine invokes nothing"],
  ]) {
    const result = await cue(["export", "-", "-e", "app"], paymentProgram() + machine(state));
    assertEquals(result.success, false, state);
    assertStringIncludes(result.stderr, reason);
  }
  const single = await cue(["export", "-", "-e", "app"], paymentProgram() + machine('{on: run: [{target: "done"}]}'));
  assertEquals(single.success, true, single.stderr);
  // XState takes the machine's transition when the state's own guard refuses;
  // a state that takes the machine's event would refuse it here instead.
  const shadowed = await cue(["export", "-", "-e", "app"], paymentProgram() + machine('{on: run: {guard: "mayRun", target: "done"}}', 'on: run: "done",'));
  assertEquals(shadowed.success, false);
  assertStringIncludes(shadowed.stderr, "the machine takes run in every state");
  const rooted = await cue(["export", "-", "-e", "app"], paymentProgram() + machine("{}", 'on: run: "done",'));
  assertEquals(rooted.success, true, rooted.stderr);
  // The machine's own transitions are held to the rule a state's are: a list
  // of two normalized to a transition that did nothing.
  const listed = await cue(["export", "-", "-e", "app"], paymentProgram() + machine("{}", 'on: run: [{target: "done", guard: "mayRun"}, {target: "ready"}],'));
  assertEquals(listed.success, false);
  assertStringIncludes(listed.stderr, "bounded.on.run: an event names one transition");
});

Deno.test("native Mecha spawn and send resolve declared bounded targets and authority", async () => {
  const target = `
app: state: hybrids: child: {rules: "child.js", machine: {
  config: {id: "child", initial: "ready", states: ready: on: tick: {}}
  setup: {
    version: 1
    initialize: "initial"
    types: {
      context: {type: "object", fields: {}}
      input: {type: "object", fields: {}}
      view: {type: "object", fields: {}}
      events: tick: {tier: "mecha", payload: {type: "object", fields: {}}}
    }
  }
}}
app: state: machines: PaymentMachine: states: pending: entry: [
  {spawn: {machine: "child", id: {raw: "NEW.id"}, input: {}, members: owner: {raw: "NEW.id"}}},
  {send: {machine: "child", id: {raw: "NEW.id"}, event: "tick", payload: {}}},
]
`;
  const files = await emitFiles(paymentProgram() + target);
  const sql = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(sql, "PERFORM hybrid_child.spawn(NEW.id,");
  assertStringIncludes(sql, "PERFORM hybrid_child.deliver(NEW.id,");
  for (const [changed, reason] of [
    [target.replaceAll('machine: "child"', 'machine: "missing"'), "undeclared Mecha operation target"],
    [target.replace('initialize: "initial"', ''), "Mecha spawn requires an initializer"],
    [target.replace('event: "tick"', 'event: "missing"'), "undeclared Mecha delivery event"],
    [target.replace('tier: "mecha"', 'tier: "omnishell"'), "delivery requires a Mecha event"],
  ]) {
    const result = await cue(["export", "-", "-e", "app"], paymentProgram() + changed);
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, reason);
  }
});

Deno.test("a bridge uses its container hatch's address and selected port", async () => {
  const files = await emitFiles(bridged(MAIL_BRIDGE.replace("8080", "9090")));
  assertEquals(JSON.parse(JSON.stringify(files["services/airlock/dapr/charge.yaml"])).data.spec.metadata[0], { name: "url", value: "http://smtp:9090" });
});

Deno.test("declaring a bridge hatch without supplying its container fails emission", async () => {
  const program = bridged(MAIL_BRIDGE).replace(/_cluster: surface: targets: smtp:.*\n/, "");
  const result = await cue(["export", "-", "-e", "out"], program);
  assertEquals(result.success, false);
  assertStringIncludes(result.stderr, "smtp");
});
