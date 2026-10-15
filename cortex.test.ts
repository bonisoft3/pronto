import { assertEquals, assertThrows, assert } from "jsr:@std/assert@1.0.11";
import { compileCortexSession, type CortexSession } from "./cortex.ts";
import type { MechaReducerMachine } from "./mecha-reducer.ts";
import { run } from "./testdata/hybrid-fixtures.ts";
import { sessionInitial, sessionTransition } from "../omnishell/interpreter/cortex-session.js";
import emitted from "../../apps/truco/shell/shared/cortex-lobby.js";

Deno.test("Cortex session composes only declared Mecha ports and private view fields", async () => {
  const result = await run("cue", ["export", "./apps/truco/machines"]);
  assert(result.ok, result.err);
  const {lobby, match, presence, challenge} = JSON.parse(result.out);
  const machines: Record<string, MechaReducerMachine> = {truco_match: match, truco_presence: presence, truco_challenge: challenge};
  const compile = (spec: CortexSession) => compileCortexSession(spec, machines);
  assertEquals<unknown>(compile(lobby), emitted, "the served protocol must match the authored composition");
  assertThrows(() => compile({...lobby, mecha: {machine: "missing", port: "session"}}));
  assertThrows(() => compile({...lobby, mecha: {machine: "truco_match", port: "session"}}));
  assertThrows(() => compile({...lobby, omnishell: {...lobby.omnishell, draft: {...lobby.omnishell.draft, path: "self.value.secret"}}}));
  assertThrows(() => compile({...lobby, omnishell: {...lobby.omnishell, rebaseUnsent: {route: "challenge", unchanged: ["self.value.phase"]}}}));
  const bad = structuredClone(machines);
  bad.truco_presence.ports!.session!.routes.offer.machine = "missing";
  assertThrows(() => compileCortexSession(lobby, bad));
  bad.truco_presence.ports!.session!.routes.offer.machine = "truco_match";
  assertThrows(() => compileCortexSession(lobby, bad), Error, "correlated receipts");
});

const snapshot = (revision = "1", phase = "hidden", name = "Ana", receipt = null) => ({self: {revision, value: {phase, name}}, receipt});
const operation = {type: "presence", command_id: "intent-1", request: {version: 1, expected_revision: "1", event: {kind: "show", payload: {name: "Bia"}}}};
const step = (state: ReturnType<typeof sessionInitial>, event: Record<string, unknown>) => sessionTransition(emitted, state, event);
const ready = () => step(step(sessionInitial(emitted), {type: "begin"}), {type: "completed", snapshot: snapshot()});

Deno.test("Cortex separates unsent drafts from transmitted intent across revisions and reload", () => {
  for (const changed of [false, true]) {
    let state = step(ready(), {type: "edit", value: ""});
    state = step(state, {type: "begin"});
    state = step(state, {type: "submit", operation});
    assertThrows(() => step(state, {type: "begin"}), Error, "in-flight");
    state = step(state, {type: "completed", snapshot: snapshot("2", "hidden", changed ? "Other tab" : "Ana")});
    assertEquals(state.draft, "");
    assertEquals(state.pending.request.expected_revision, changed ? "1" : "2");
    state = step(state, {type: "begin"});
    const sent = structuredClone(state.pending);
    state = step(state, {type: "unavailable"});
    state = sessionInitial(emitted, JSON.parse(JSON.stringify(state.pending)));
    state = step(state, {type: "begin"});
    assertEquals(state.inFlight.operation, sent, "reload must resend the exact intent");
    assertThrows(() => step(state, {type: "completed", snapshot: {...snapshot("3"), receipt: {command_id: "other", kind: "accepted"}}}));
    for (const kind of ["accepted", "rejected"]) {
      const next = step(state, {type: "completed", snapshot: {...snapshot("3"), receipt: {command_id: sent.command_id, kind}}});
      assertEquals([next.phase, next.pending, next.receipt.kind], ["ready", null, kind]);
    }
  }
});

Deno.test("Cortex bounded delivery schedules preserve one intent and stop on close", () => {
  let frontier = [ready()];
  let checked = 0;
  const seen = new Set<string>();
  for (let depth = 0; depth < 9; depth++) {
    const next = [];
    for (const state of frontier) {
      const events: Record<string, unknown>[] = [{type: "close"}];
      if (state.phase === "ready") events.push({type: "submit", operation});
      if (!["failed", "closed"].includes(state.phase)) {
        events.push({type: "edit", value: "draft"});
        if (!state.inFlight) events.push({type: "begin"});
        else events.push({type: "unavailable"}, {type: "failure", message: "bad response"}, {type: "completed", snapshot: {...snapshot("2"), receipt: state.inFlight.operation ? {command_id: operation.command_id, kind: "accepted"} : null}});
      }
      for (const event of events) {
        const result = step(state, event);
        checked++;
        if (state.phase === "closed") assertEquals(result, state);
        if (result.pending) assertEquals(result.pending.command_id, operation.command_id);
        if (state.pending && !result.pending) {
          assertEquals(event.type, "completed");
          assertEquals(state.inFlight.operation.command_id, operation.command_id);
        }
        if (state.transmitted && result.pending) assertEquals(result.pending, state.pending);
        assertEquals(state.snapshot?.self.value.phase, "hidden", "client intent never writes server visibility");
        const key = JSON.stringify(result);
        if (!seen.has(key)) {seen.add(key); next.push(result);}
      }
    }
    frontier = next;
  }
  assert(checked > 100);
});

Deno.test("Cortex command composition binds existing admission and filters server-only events", async () => {
  const {compileCortex} = await import("./cortex.ts");
  const {commandInitial, commandTransition} = await import("../omnishell/interpreter/cortex-command.js");
  const {default: table} = await import("../../apps/truco/shell/shared/cortex-table.js");
  const result = await run("cue", ["export", "./apps/truco/machines"]);
  assert(result.ok, result.err);
  const {table: spec, match} = JSON.parse(result.out);
  assertEquals<unknown>(compileCortex(spec, {truco_match: match}), table);
  assert(!table.mecha.events.includes("timeout"));
  const state = {...commandInitial(table), phase: "ready", view: {revision: "1", value: {}}};
  assertThrows(() => commandTransition(table, state, {type: "submit", command: {command_id: "timer", request: {expected_revision: "1", event: {kind: "timeout"}}}}));
  const bad = structuredClone(match);
  bad.ports.admission.public = false;
  assertThrows(() => compileCortex(spec, {truco_match: bad}), Error, "public admission");
});

Deno.test("Cortex command driver retries admission and moves exactly, and ignores responses after close", async () => {
  const {mountCommand} = await import("../omnishell/interpreter/cortex-command.js");
  const {default: chart} = await import("../../apps/truco/shell/shared/cortex-table.js");
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => Promise<void>>();
  let serial = 0;
  globalThis.setTimeout = (((fn: () => Promise<void>) => {timers.set(++serial, fn); return serial;}) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (((id?: unknown) => {if (typeof id === "number") timers.delete(id);}) as unknown) as typeof clearTimeout;
  const records = new Map<string, string>();
  const storage = {getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value), removeItem: (key: string) => records.delete(key)};
  const requests: {name: string; body: Record<string, unknown>}[] = [];
  const unavailable = () => Object.assign(new Error("lost reply"), {name: "UnknownOutcome"});
  let dropCreate = true;
  let dropMove = true;
  let holdRead = false;
  let release: ((value: unknown) => void) | undefined;
  let revision = "1";
  const rpc = async (name: string, body: Record<string, unknown>) => {
    requests.push({name, body: structuredClone(body)});
    if (name === chart.mecha.create && dropCreate) {dropCreate = false; throw unavailable();}
    if (name === chart.mecha.command) {
      revision = "2";
      if (dropMove) {dropMove = false; throw unavailable();}
      return {command_id: body.command_id, kind: "accepted", revision};
    }
    if (name === chart.mecha.sync && holdRead) return await new Promise(resolve => {release = resolve;});
    return {revision, value: {phase: "playing"}};
  };
  const controller = new AbortController();
  let finalState: unknown;
  let changes = 0;
  const make = (signal: AbortSignal) => mountCommand(chart, {signal, rpc, storage, prefix: "test", changed: (state: unknown) => {finalState = state; changes++;}, opened: () => {}});
  const tick = async () => {
    const [key, fn] = [...timers][0];
    timers.delete(key);
    await fn();
  };
  let second: AbortController | undefined;
  try {
    const client = make(controller.signal);
    await client.open("room", "create", {variant: "mineiro", seating: "1v1"});
    assertEquals(JSON.parse(records.get("test:opening")!).input, {variant: "mineiro", seating: "1v1"});
    assertThrows(() => client.open("other", "join"), Error, "unresolved outcome");
    await tick();
    assertEquals(requests.filter(r => r.name === chart.mecha.create)[0], requests.filter(r => r.name === chart.mecha.create)[1]);
    assertEquals(storage.getItem("test:opening"), null);
    await client.submit("play", {slot: 0, covered: false});
    const original = JSON.parse(records.get("test:room")!).pending;
    assert(original);
    controller.abort();
    second = new AbortController();
    const restored = make(second.signal);
    await restored.open("room");
    const commands = requests.filter(r => r.name === chart.mecha.command);
    assertEquals(commands.length, 2);
    assertEquals(commands[0], commands[1]);
    assertEquals(JSON.parse(records.get("test:room")!).pending, null);
    holdRead = true;
    const waiting = tick();
    await Promise.resolve();
    second.abort();
    const count = changes;
    release!({revision: "3", value: {phase: "finished"}});
    await waiting;
    assertEquals(changes, count, "late views must not publish after navigation");
    assertEquals((finalState as {view: {revision: string}}).view.revision, "2");
    assertEquals(timers.size, 0);
  } finally {
    controller.abort();
    second?.abort();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

Deno.test("Cortex blocks sends on persistence failure and releases definitively refused admission", async () => {
  const {mountCommand} = await import("../omnishell/interpreter/cortex-command.js");
  const {default: chart} = await import("../../apps/truco/shell/shared/cortex-table.js");
  const records = new Map<string, string>();
  let failStorage = false;
  let calls = 0;
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {if (failStorage) throw new Error("quota exceeded"); records.set(key, value);},
    removeItem: (key: string) => records.delete(key),
  };
  const controller = new AbortController();
  const client = mountCommand(chart, {
    signal: controller.signal, storage, prefix: "test", changed: () => {}, opened: () => {},
    rpc: (_name: string, body: {instance_id: string}) => {
      calls++;
      if (body.instance_id === "full") throw Object.assign(new Error("room full"), {name: "ProtocolError"});
      return Promise.resolve({revision: "1", value: {}});
    },
  });
  try {
    await client.open("full");
    assertEquals(storage.getItem("test:opening"), null);
    await client.open("available");
    const before = calls;
    failStorage = true;
    assertThrows(() => client.submit("play", {slot: 0, covered: false}), Error, "quota exceeded");
    assertEquals(calls, before);
    assertEquals(JSON.parse(records.get("test:available")!).pending, null);
  } finally {
    failStorage = false;
    controller.abort();
  }
});
