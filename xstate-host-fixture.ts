import { assign, createMachine, initialTransition, raise, transition } from "npm:xstate@5.32.6";

const effect = (name: string) => ({ type: "effect", params: { name } });
const machine = createMachine({
  initial: "idle",
  context: { count: 0 },
  states: {
    idle: {
      entry: effect("enter-idle"),
      exit: effect("exit-idle"),
      on: {
        GO: [
          { guard: ({ event }) => event.allow === false, target: "rejected", actions: effect("first") },
          { guard: ({ event }) => event.allow === true, target: "active", actions: [assign({ count: ({ context }) => context.count + 1 }), effect("second"), raise({ type: "INTERNAL" })] },
          { target: "rejected", actions: effect("fallback") },
        ],
      },
    },
    active: {
      entry: effect("enter-active"),
      exit: effect("exit-active"),
      on: {
        INTERNAL: { actions: effect("internal") },
        STAY: { actions: [assign({ count: ({ context }) => context.count + 1 }), effect("stay")] },
        SELF: { target: "active", reenter: true, actions: effect("self") },
        BACK: { target: "idle", actions: effect("back") },
        FAIL: { guard: () => { throw new Error("guard failed"); }, target: "rejected" },
      },
    },
    rejected: {},
  },
}, { actions: { effect: () => { throw new Error("effect ran"); } } });

(globalThis as any).xstateHost = (input: any) => {
  const [snapshot, actions] = input.snapshot == null
    ? initialTransition(machine)
    : transition(machine, machine.resolveState(input.snapshot), input.event);
  return {
    snapshot: { value: snapshot.value, context: snapshot.context },
    effects: actions.map(({ type, params }: any) => ({ type, params })),
  };
};
