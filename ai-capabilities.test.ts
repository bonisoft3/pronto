import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles } from "./effects-fixtures.ts";

function aiProgram({
  ai = `{text: ["browser", "cheap", "heavy"], image: ["browser", "cheap", "heavy"]}`,
  sink = `{ai: "text", tier: "cheap", idempotent: true}`,
  vendored = "",
  targets = `["pages", "cloudflare"]`,
  clocks = `["cloudflare"]`,
} = {}): string {
  return `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  meta: {
    name: "test-ai"
    description: "test"
    ir: sha256: ""
    targets: ${targets}
    clocks: ${clocks}
    decisions: {}
    tests: {}
  }
  state: {
    entities: {
      Draft: {
        table: "draft"
        durability: "server"
        fields: [
          {name: "id", type: "uuid", pk: true},
          {name: "status", type: "string"},
          {name: "topic", type: "string"},
          {name: "failure", type: "string"},
        ]
      }
      BrowserDraft: {
        table: "browser_draft"
        durability: "device"
        uniques: [{name: "uq_browser_draft_topic", cols: ["topic"]}]
        fields: [
          {name: "id", type: "string", pk: true},
          {name: "topic", type: "string"},
          {name: "w0", type: "string"},
        ]
      }
    }
    machines: DraftMachine: {
      name: "DraftMachine"
      entity: "Draft"
      field: "status"
      initial: "idle"
      states: {
        idle: on: generate: "drafting"
        drafting: invoke: {
          src: "draft"
          onDone: "done"
          onError: {target: "failed", actions: [{assign: {failure: {raw: "outcome->>'kind'"}}}]}
        }
        done: type: "final"
        failed: on: retry: "idle"
      }
    }
    effects: draft: {
      input: {topic: "NEW.topic"}
      sink: ${sink}
      note: "bifrost AI gateway is idempotent for deterministic prompt generation"
    }
  }
  capabilities: {
    hatches: {}
    vendored: {${vendored}}
    ${ai ? `ai: ${ai}` : ""}
  }
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{table: "draft", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
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

Deno.test("capabilities.ai with model overrides and agent browser unit compiles and emits bifrost Dapr binding", async () => {
  const code = aiProgram({
    ai: `{
      text: ["browser", "cheap", "heavy"]
      image: ["browser", "cheap", "heavy"]
      models: text: heavy: {model: "gemma4:26b-custom"}
      targets: cloudflare: image: heavy: {model: "@cf/black-forest-labs/flux-2-klein-9b", size: "1024x1024", steps: 4}
    }`,
    vendored: `
      "ai-browser": {
        isolation: "agent"
        ports: {reads: ["Draft"], raises: ["draft_ready"]}
        memo: {entity: "BrowserDraft", key: ["topic"]}
        src: "shell/units/ai-browser/unit.js"
        files: ["shell/units/ai-browser/unit.js"]
        note: "Tier 0 browser AI worker"
      }
    `,
  });
  const vet = await cue(["vet", "-c", "-"], code);
  assert(vet.success, vet.stderr);
  const files = await emitFiles(code) as unknown as Record<string, { data: Record<string, unknown> }>;
  const dapr = files["services/airlock/dapr/draft.yaml"].data as {
    spec: { metadata: { name: string; value: string }[] };
  };
  assertEquals(dapr.spec.metadata[0], { name: "url", value: "http://bifrost:8090" });
  const shell = files["shell/shell.yaml"].data as { ai: { text: string[]; models: { text: { heavy: { model: string } } } } };
  assertEquals(shell.ai.text, ["browser", "cheap", "heavy"]);
  assertEquals(shell.ai.models.text.heavy.model, "gemma4:26b-custom");
});

Deno.test("an AI effect without capabilities.ai or with an undeclared tier is refused", async () => {
  const noCap = await cue(["vet", "-c", "-"], aiProgram({ ai: "" }));
  assertEquals(noCap.success, false);
  assertStringIncludes(noCap.stderr, "effect draft reaches AI modality text without capabilities.ai declared");

  const missingTier = await cue(
    ["vet", "-c", "-"],
    aiProgram({ ai: `{text: ["browser", "cheap"]}`, sink: `{ai: "text", tier: "heavy", idempotent: true}` }),
  );
  assertEquals(missingTier.success, false);
  assertStringIncludes(missingTier.stderr, "effect draft reaches AI text tier heavy, which is not declared in capabilities.ai.text");
});
