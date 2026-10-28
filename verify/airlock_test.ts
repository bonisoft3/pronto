import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { airlock, type AirlockDoor, type AirlockSpec } from "./airlock.ts";

Deno.test("airlock executes forward journey, verifies, and runs rollback in finally", async () => {
  const trace: string[] = [];
  const mockDoor: AirlockDoor = {
    async mutate(action: string, payload?: unknown) {
      trace.push(`door.mutate:${action}:${JSON.stringify(payload)}`);
    },
  };

  const journey = airlock({
    accepts: "accept-sample-write",
    screen: "sample-screen",
    role: "admin",
    async execute(_page) {
      trace.push("execute");
      return { noteId: "note-123" };
    },
    async verify(_page, state) {
      trace.push(`verify:${state.noteId}`);
    },
    async rollback(state, door) {
      trace.push(`rollback:${state.noteId}`);
      await door?.mutate("delete_note", { id: state.noteId });
    },
  });

  await journey.run({}, { door: mockDoor });

  assertEquals(trace, [
    "execute",
    "verify:note-123",
    "rollback:note-123",
    'door.mutate:delete_note:{"id":"note-123"}',
  ]);
});

Deno.test("airlock runs compensating rollback even when verification fails", async () => {
  const trace: string[] = [];

  const journey = airlock({
    screen: "failing-verification",
    async execute(_page) {
      trace.push("execute");
      return { recordId: "rec-456" };
    },
    async verify(_page, _state) {
      trace.push("verify");
      throw new Error("assertion failure: DOM element missing");
    },
    async rollback(state) {
      trace.push(`rollback:${state.recordId}`);
    },
  });

  await assertRejects(
    async () => await journey.run({}),
    Error,
    "assertion failure: DOM element missing"
  );

  assertEquals(trace, ["execute", "verify", "rollback:rec-456"]);
});

Deno.test("airlock refuses spec without compensating rollback", () => {
  assertThrows(
    () =>
      // deno-lint-ignore no-explicit-any
      airlock({
        screen: "unsafe-write",
        async execute() {
          return {};
        },
      } as any),
    Error,
    "must define a compensating rollback function"
  );
});

Deno.test("airlock reports both primary error and rollback failure when both fail", async () => {
  const journey = airlock({
    screen: "double-fault",
    async execute() {
      return { id: "fault-1" };
    },
    async verify() {
      throw new Error("primary verification error");
    },
    async rollback() {
      throw new Error("database rollback failed: network timeout");
    },
  });

  await assertRejects(
    async () => await journey.run({}),
    Error,
    "Airlock journey failed (primary verification error) and compensating rollback also failed: database rollback failed: network timeout"
  );
});

Deno.test("airlock runs compensating rollback when execute records state then throws", async () => {
  const trace: string[] = [];

  const journey = airlock<{ createdId: string }>({
    screen: "partial-execution-failure",
    async execute(_page, ctx) {
      trace.push("execute:start");
      ctx?.recordState?.({ createdId: "partial-999" });
      trace.push("execute:mutated");
      throw new Error("unexpected error after mutation");
    },
    async rollback(state: { createdId: string }) {
      trace.push(`rollback:${state.createdId}`);
    },
  });

  await assertRejects(
    async () => await journey.run({}),
    Error,
    "unexpected error after mutation"
  );

  assertEquals(trace, ["execute:start", "execute:mutated", "rollback:partial-999"]);
});

Deno.test("airlock executes rollback for void-returning journey with closure cleanup", async () => {
  let cleaned = false;
  const journey = airlock({
    screen: "void-mutation",
    async execute() {
      // mutates via side effect and returns void
    },
    async rollback() {
      cleaned = true;
    },
  });

  await journey.run({});
  assertEquals(cleaned, true);
});

Deno.test("airlock runs rollback when execute throws before recordState or completion", async () => {
  let cleaned = false;
  const journey = airlock({
    screen: "partial-throw-before-record",
    async execute() {
      // Side effect committed, but thrown before recordState
      throw new Error("submission timed out after write");
    },
    async rollback() {
      cleaned = true;
    },
  });

  await assertRejects(
    async () => await journey.run({}),
    Error,
    "submission timed out after write"
  );
  assertEquals(cleaned, true);
});
