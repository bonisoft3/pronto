import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { walkAst, checkDuckStreams, type DuckStream } from "./check-sql.ts";

Deno.test("walkAst extracts distinct, windowing, and cross join operators from the AST", () => {
  const ast = {
    statements: [
      {
        node: {
          type: "SELECT_NODE",
          modifiers: [{ type: "DISTINCT_MODIFIER" }],
          select_list: [
            {
              class: "FUNCTION",
              function_name: "tumble",
              children: [],
            },
            {
              class: "FUNCTION",
              function_name: "count",
              distinct: true,
              children: [],
            },
          ],
          from_table: {
            type: "JOIN",
            ref_type: "CROSS",
          },
        },
      },
    ],
  };

  const detected = new Set<string>();
  walkAst(ast, detected);
  assertEquals(detected.has("tumble"), true);
  assertEquals(detected.has("distinct"), true);
  assertEquals(detected.has("cross_join"), true);
});

Deno.test("walkAst identifies bounded interval comparisons in join conditions", () => {
  const ast = {
    statements: [
      {
        node: {
          type: "SELECT_NODE",
          modifiers: [],
          select_list: [],
          from_table: {
            type: "JOIN",
            condition: {
              type: "COMPARE_BETWEEN",
              children: [{ function_name: "to_minutes" }],
            },
          },
        },
      },
    ],
  };

  const detected = new Set<string>();
  walkAst(ast, detected);
  assertEquals(detected.has("interval_join"), true);
});

Deno.test("a windowing pipeline cannot run hot because its output waits for the watermark", async () => {
  const ds: Record<string, DuckStream> = {
    windowed_stream: {
      name: "windowed_stream",
      sql: "SELECT TUMBLE(epoch, INTERVAL '1' HOUR) as w, count(*) FROM event GROUP BY 1",
      sources: ["event"],
      sink: "hourly_metric",
      tempo: "hot",
      operators: ["tumble"],
    },
  };

  const findings = await checkDuckStreams(ds, ".");
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0].message, "requires tempo: \"cold\"");
});

Deno.test("an undeclared relational operator is refused at lint time", async () => {
  const ds: Record<string, DuckStream> = {
    distinct_stream: {
      name: "distinct_stream",
      sql: "SELECT DISTINCT visitor FROM event",
      sources: ["event"],
      sink: "visitors",
      tempo: "hot",
    },
  };

  const findings = await checkDuckStreams(ds, ".");
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0].message, "uses operator \"distinct\" but does not declare it");
});

Deno.test("a declared operator matching the query passes lint without findings", async () => {
  const ds: Record<string, DuckStream> = {
    windowed_cold: {
      name: "windowed_cold",
      sql: "SELECT TUMBLE(epoch, INTERVAL '1' HOUR) as w, count(*) FROM event GROUP BY 1",
      sources: ["event"],
      sink: "hourly_metric",
      tempo: "cold",
      operators: ["tumble"],
    },
  };

  const findings = await checkDuckStreams(ds, ".");
  assertEquals(findings.length, 0);
});

Deno.test("a declared operator unused by the query is refused at lint time", async () => {
  const ds: Record<string, DuckStream> = {
    unused_operator: {
      name: "unused_operator",
      sql: "SELECT visitor FROM event",
      sources: ["event"],
      sink: "visitors",
      tempo: "hot",
      operators: ["distinct"],
    },
  };

  const findings = await checkDuckStreams(ds, ".");
  assertEquals(findings.length, 1);
  assertStringIncludes(findings[0].message, "declares operator \"distinct\" in operators: [...] but the query does not use it");
});

Deno.test("a screen that mutates an entity cannot read a cold derivation of it", async () => {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-hot-proof"
    description: "test"
    ir: sha256: ""
    targets: []
    clocks: []
    decisions: {}
    tests: {}
    design: pendingLiterals: 0
  }
  state: {
    entities: {
      Expense: {
        table: "expense"
        durability: "offline"
        fields: [{name: "id", type: "uuid", pk: true}]
      }
      CategoryMonthStat: {
        table: "category_month_stat"
        durability: "offline"
        fields: [{name: "id", type: "string", pk: true}]
      }
    }
    duckstreams: {
      recount: {
        name: "recount"
        sources: ["expense"]
        sink: "category_month_stat"
        tempo: "cold"
        sql: "SELECT * FROM expense"
      }
    }
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: {
      Ledger: {
        title: "Ledger"
        route: "/ledger"
        markup: "<main></main>"
        reads: [{entity: "CategoryMonthStat"}]
        forms: [{
          id: "add_expense"
          entity: "expense"
          action: "create"
          fields: []
        }]
        states: []
        paths: {}
      }
    }
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
  assertStringIncludes(err, "cold pipeline cannot feed an active screen mutation loop: recount feeds category_month_stat on screen Ledger");

  // With tempo: "hot", the exact same program vets cleanly
  const hotCueCode = cueCode.replace('tempo: "cold"', 'tempo: "hot"');
  const hotChild = new Deno.Command("cue", {
    args: ["vet", "-c", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const hotWriter = hotChild.stdin.getWriter();
  await hotWriter.write(new TextEncoder().encode(hotCueCode));
  await hotWriter.close();
  const hotRes = await hotChild.output();
  assertEquals(hotRes.success, true);
});
