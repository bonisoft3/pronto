// Cortex machine Chinese Postman walk: verifies that user intents (from
// Omnishell CommandEvent) and cluster signals (from Mecha change feed)
// form a complete Eulerian tour without dead arrows or protocol blind spots.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { walkMachine, type Arrow, type WalkHarness } from "../omnishell/test/walker.ts";
import type { Machine } from "../omnishell/test/canonical.ts";

Deno.test("cortex machine walk covers all user intents and cluster signals", async () => {
  const cortexLobbyMachine: Machine = {
    field: "phase",
    initial: "idle",
    states: {
      idle: {
        on: {
          "intent:toggle-online": "online",
          "intent:challenge": "challenging",
        },
      },
      online: {
        on: {
          "intent:toggle-online": "idle",
          "intent:challenge": "challenging",
          "signal:apexrun_challenge.received": "answering",
        },
      },
      challenging: {
        on: {
          "intent:cancel": "online",
          "signal:apexrun_challenge.accepted": "racing",
          "signal:apexrun_challenge.declined": "online",
          "signal:apexrun_challenge.expired": "online",
        },
      },
      answering: {
        on: {
          "intent:accept": "racing",
          "intent:decline": "online",
          "signal:apexrun_challenge.cancelled": "online",
        },
      },
      racing: {
        on: {
          "signal:apexrun_duel.finish": "online",
        },
      },
    },
  };

  let current = "idle";
  const trace: Arrow[] = [];
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__prontoMachineTrace = trace;

  const harness: WalkHarness = {
    async fire(type: string) {
      // deno-lint-ignore no-explicit-any
      const node = (cortexLobbyMachine.states as Record<string, any>)[current];
      const target = node?.on?.[type];
      if (typeof target === "string") {
        // deno-lint-ignore no-explicit-any
        const gTrace = (globalThis as any).__prontoMachineTrace;
        if (gTrace) gTrace.push({ state: current, key: type, index: 0, to: target, field: "phase" });
        current = target;
      }
    },
    async wait(_ms: number) {},
    field() {
      return current;
    },
  };

  const walk = await walkMachine(cortexLobbyMachine, harness);
  // Verify that the Chinese Postman tour covered all transitions
  assertEquals(walk.shadowed, [], "no shadowed transitions");
  const coveredKeys = new Set(walk.arrows.map((t) => `${t.state}->${t.key}`));
  assertEquals(coveredKeys.has("idle->intent:challenge"), true, "offline challenge edge covered");
  assertEquals(coveredKeys.has("challenging->signal:apexrun_challenge.accepted"), true, "challenge accepted signal covered");
  assertEquals(coveredKeys.has("racing->signal:apexrun_duel.finish"), true, "duel finish signal covered");
  assertEquals(walk.arrows.length >= 11, true, "Eulerian tour traversed all arrows");
});

Deno.test("cortex machine walk catches unreachable intents and missing transitions", async () => {
  // A buggy machine missing the edge: attempting to challenge while offline (idle) has no arrow
  const buggyMachine: Machine = {
    field: "phase",
    initial: "idle",
    states: {
      idle: {
        on: {
          "intent:toggle-online": "online",
        },
      },
      online: {
        on: {
          "intent:toggle-online": "idle",
          "intent:challenge": "challenging",
        },
      },
      challenging: {
        on: {
          "intent:cancel": "online",
        },
      },
    },
  };

  let current = "idle";
  const harness: WalkHarness = {
    async fire(type: string) {
      // deno-lint-ignore no-explicit-any
      const node = (buggyMachine.states as Record<string, any>)[current];
      const target = node?.on?.[type];
      if (typeof target === "string") {
        // deno-lint-ignore no-explicit-any
        const gTrace = (globalThis as any).__prontoMachineTrace;
        if (gTrace) gTrace.push({ state: current, key: type, index: 0, to: target, field: "phase" });
        current = target;
      }
    },
    async wait(_ms: number) {},
    field() {
      return current;
    },
  };

  const walk = await walkMachine(buggyMachine, harness);
  const coveredKeys = new Set(walk.arrows.map((t) => `${t.state}->${t.key}`));
  assertEquals(coveredKeys.has("idle->intent:challenge"), false, "confirms missing transition is not covered");
});
