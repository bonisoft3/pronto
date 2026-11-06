import { compileMechaReducer } from "../../../mecha-reducer.ts";
import { terminal } from "../../../testdata/mecha-fixtures.ts";
import { executeMecha } from "../../../mecha-local.ts";
import { machine } from "./machine.ts";

type State = {
  phase: string;
  requested: number;
  claimed: number;
  published: number;
  attempt: number;
  lease_until: number;
  completed_attempt: number;
  completed_revision: number;
  artifact: string;
};
type Answer = { kind: string; reason?: string; state: State };
const rules = await Deno.readTextFile(new URL("./rules.js", import.meta.url));
const compiled = await compileMechaReducer(machine, rules, terminal);
const context = (now: number) => ({ tier: "mecha", actor: null, now });
const initial = async () =>
  (await executeMecha(compiled.source, machine.fuel, {
    initialize: true,
    payload: {},
    context: context(0),
    viewers: [],
  }) as { state: State }).state;
const step = async (state: State, kind: string, payload = {}, now = 1) =>
  await executeMecha(compiled.source, machine.fuel, {
    state,
    event: { kind, payload },
    context: context(now),
    viewers: [],
  }) as Answer;
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
async function accept(state: State, kind: string, payload = {}, now = 1) {
  const answer = await step(state, kind, payload, now);
  equal(answer.kind, "accepted");
  return answer.state;
}
const result = (
  state: State,
  artifact = `immutable/${state.claimed}/${state.attempt}`,
) => ({
  revision: state.claimed,
  attempt: state.attempt,
  artifact,
});
async function running(revision = 1) {
  return await accept(
    await accept(await initial(), "invalidate", { revision }),
    "claim",
  );
}

Deno.test("new invalidations survive completion and publication of the immutable claim", async () => {
  let state = await running(4);
  const first = result(state);
  state = await accept(state, "invalidate", { revision: 9 });
  state = await accept(state, "invalidate", { revision: 7 });
  equal([state.requested, state.claimed], [9, 4]);
  state = await accept(state, "complete", first);
  equal([state.phase, state.published], ["publishing", 0]);
  equal((await step(state, "claim")).reason, "illegal_event");
  state = await accept(state, "invalidate", { revision: 12 });
  state = await accept(state, "acknowledge", first);
  equal([state.phase, state.requested, state.published], ["idle", 12, 4]);
  state = await accept(state, "claim");
  equal([state.phase, state.claimed, state.attempt], ["running", 12, 2]);
});

Deno.test("failed work retries the same claim and fences the failed worker", async () => {
  let state = await running(4);
  const stale = result(state);
  state = await accept(state, "fail", { attempt: 1 });
  state = await accept(state, "invalidate", { revision: 9 });
  state = await accept(state, "claim");
  equal([state.claimed, state.requested, state.attempt], [4, 9, 2]);
  equal((await step(state, "complete", stale)).reason, "stale_attempt");
  equal((await step(state, "fail", { attempt: 1 })).reason, "stale_attempt");
  equal(
    (await step(state, "complete", { ...result(state), revision: 9 })).reason,
    "wrong_revision",
  );
  state = await accept(state, "complete", result(state));
  equal(state.phase, "publishing");
});

Deno.test("lease expiry rejects late completion and requires an explicit fenced retry", async () => {
  let state = await running();
  equal(
    (await step(state, "expire", { attempt: 1 }, 100)).reason,
    "lease_active",
  );
  equal(
    (await step(state, "complete", result(state), 101)).reason,
    "lease_expired",
  );
  state = await accept(state, "expire", { attempt: 1 }, 101);
  state = await accept(state, "claim", {}, 101);
  equal([state.attempt, state.lease_until], [2, 201]);
  equal(
    (await step(state, "expire", { attempt: 1 }, 202)).reason,
    "stale_attempt",
  );
  state = await accept(state, "complete", result(state), 200);
  equal(state.phase, "publishing");
});

Deno.test("lost replies and duplicate completion or acknowledgment do not change accepted work", async () => {
  let state = await running();
  const first = result(state);
  state = await accept(state, "complete", first);
  state = JSON.parse(JSON.stringify(state));
  equal(await accept(state, "complete", first, 500), state);
  equal(
    (await step(state, "complete", { ...first, artifact: "different" })).reason,
    "conflicting_result",
  );
  equal(
    (await step(state, "acknowledge", { ...first, artifact: "different" }))
      .reason,
    "unknown_publication",
  );
  state = await accept(state, "acknowledge", first);
  equal(await accept(state, "acknowledge", first), state);
  equal(await accept(state, "complete", first), state);
  state = await accept(state, "invalidate", { revision: 2 });
  state = await accept(state, "claim");
  equal(await accept(state, "complete", first), state);
  equal(await accept(state, "acknowledge", first), state);
  state = await accept(state, "complete", result(state));
  equal((await step(state, "complete", first)).reason, "stale_attempt");
  equal(
    (await step(state, "acknowledge", first)).reason,
    "unknown_publication",
  );
});

Deno.test("an acknowledgment cannot invent completion or advance the published frontier", async () => {
  let state = await running(5);
  equal(
    (await step(state, "acknowledge", result(state))).reason,
    "unknown_publication",
  );
  equal(
    (await step(state, "complete", result(state, ""))).reason,
    "empty_artifact",
  );
  state = await accept(state, "complete", result(state));
  equal(
    (await step(state, "acknowledge", { ...result(state), revision: 6 }))
      .reason,
    "unknown_publication",
  );
  state = await accept(state, "acknowledge", result(state));
  equal((await step(state, "claim")).reason, "no_work");
  equal(await accept(state, "invalidate", { revision: 3 }), state);
});

Deno.test("bounded counters and deadlines refuse exhaustion without wrapping identity", async () => {
  let state = await running();
  state = await accept(state, "fail", { attempt: 1 });
  equal(
    (await step({ ...state, attempt: Number.MAX_SAFE_INTEGER }, "claim"))
      .reason,
    "attempt_exhausted",
  );
  equal(
    (await step(state, "claim", {}, Number.MAX_SAFE_INTEGER)).reason,
    "invalid_clock",
  );
});

Deno.test("all permutations of arrival around completion and acknowledgment retain the newest revision", async () => {
  for (const position of [0, 1, 2]) {
    let state = await running(3);
    const publication = result(state);
    const events: [string, object][] = [["complete", publication], [
      "acknowledge",
      publication,
    ]];
    events.splice(position, 0, ["invalidate", { revision: 7 }]);
    for (const [kind, payload] of events) {
      state = await accept(state, kind, payload);
    }
    equal([state.phase, state.published, state.requested], ["idle", 3, 7]);
    state = await accept(state, "claim");
    equal(state.claimed, 7);
  }
});
