import type { MechaReducerMachine, Shape } from "./mecha-reducer.ts";

export type CortexSession = {
  mecha: {machine: string; port: "session"};
  omnishell: {
    pollMs: number;
    draft: {path: string; locked: {path: string; equals: string}};
    rebaseUnsent?: {route: string; unchanged: string[]};
  };
};

export function compileCortexSession(spec: CortexSession, machines: Record<string, MechaReducerMachine>) {
  const machine = machines[spec.mecha.machine];
  const port = machine?.ports?.session;
  if (spec.mecha.port !== "session" || !port) throw new Error("Cortex requires a declared Mecha session port");
  if (!Number.isInteger(spec.omnishell.pollMs) || spec.omnishell.pollMs < 100 || spec.omnishell.pollMs > 60000) throw new Error("invalid Cortex poll interval");
  const field = (path: string): Shape => {
    const parts = path.split(".");
    if (parts.shift() !== "self" || parts.shift() !== "value") throw new Error("Cortex session fields must belong to the private self view");
    let shape = machine.view;
    for (const part of parts) {
      if (!/^[a-z][a-z0-9_]*$/.test(part) || shape.type !== "object" || !shape.fields[part]) throw new Error(`unknown Cortex view field ${path}`);
      shape = shape.fields[part];
    }
    return shape;
  };
  if (field(spec.omnishell.draft.path).type !== "string" || field(spec.omnishell.draft.locked.path).type !== "string") throw new Error("Cortex draft requires string fields");
  const rebase = spec.omnishell.rebaseUnsent;
  if (rebase) {
    const route = port.routes[rebase.route];
    if (route?.kind !== "command" || route.machine !== machine.name || !rebase.unchanged.length) throw new Error("Cortex may rebase only unsent commands to its own session machine");
    for (const path of rebase.unchanged) field(path);
  }
  for (const route of Object.values(port.routes)) {
    const target = machines[route.machine];
    if (!target || (route.kind === "admission" && target.ports?.admission?.result !== "receipt")) throw new Error("Cortex routes require declared machines and correlated receipts");
  }
  const common = {
    begin: {actions: ["capture"]},
    completed: [
      {guard: "queued", target: "sending", actions: ["snapshot"]},
      {target: "ready", actions: ["receipt"]},
    ],
    unavailable: {target: "reconnecting", actions: ["release"]},
    failure: {target: "failed", actions: ["fail"]},
    edit: {actions: ["draft"]},
    close: {target: "closed", actions: ["release"]},
  };
  return {
    version: 1,
    mecha: {machine: machine.name, sync: port.name, leave: port.leave.name, routes: Object.fromEntries(Object.entries(port.routes).map(([name, route]) => [name, {machine: route.machine, kind: route.kind}]))},
    omnishell: spec.omnishell,
    initial: "connecting",
    states: {
      connecting: {tier: "omnishell", on: common},
      ready: {tier: "omnishell", on: {...common, submit: {target: "sending", actions: ["enqueue"]}}},
      sending: {tier: "omnishell", on: common},
      reconnecting: {tier: "omnishell", on: common},
      failed: {tier: "omnishell", on: {close: common.close}},
      closed: {tier: "omnishell", final: true, on: {}},
    },
  };
}

export type CortexCommand = {mecha: {machine: string; port: "sync"}; omnishell: {pollMs: number}};

export function compileCortex(spec: CortexSession | CortexCommand, machines: Record<string, MechaReducerMachine>) {
  if (spec.mecha.port === "session") return compileCortexSession(spec as CortexSession, machines);
  const machine = machines[spec.mecha.machine];
  const ports = machine?.ports;
  if (spec.mecha.port !== "sync" || !ports?.sync || !ports.join || !ports.admission?.public || ports.admission.result !== "view") throw new Error("Cortex command composition requires public admission, join and sync ports");
  if (!Number.isInteger(spec.omnishell.pollMs) || spec.omnishell.pollMs < 100 || spec.omnishell.pollMs > 60000) throw new Error("invalid Cortex poll interval");
  if (ports.admission.id !== "instance_id" || !ports.admission.params.some(p => p.name === "instance_id" && p.type === "uuid")) throw new Error("Cortex admission requires an instance_id parameter");
  const reconcile = (action: string, phases: string[]) => [
    ...phases.map(phase => ({guard: phase, target: phase, actions: [action]})),
    {actions: [action]},
  ];
  const on = {
    admission_refused: {target: "failed", actions: ["refuse_admission"]},
    open: {target: "connecting", actions: ["open"]},
    begin: {actions: ["capture"]},
    completed: {actions: ["release"]},
    admitted: {actions: ["admitted"]},
    submit: {target: "submitting", actions: ["submit"]},
    outcome: reconcile("outcome", ["ready", "rejected", "awaiting_view"]),
    view: reconcile("view", ["ready"]),
    unknown: reconcile("unknown", ["unknown"]),
    retry: {target: "submitting", actions: ["retry"]},
    unavailable: {target: "reconnecting"},
    failure: {target: "failed"},
    close: {target: "closed", actions: ["release"]},
  };
  return {
    version: 1,
    mecha: {
      machine: machine.name, version: machine.version,
      create: ports.admission.name, inputs: ports.admission.params.filter(p => p.name !== "instance_id").map(p => p.name), joinInputs: ports.join.seats ? ["requested_seat"] : [], join: ports.join.name, sync: ports.sync.name,
      command: `${machine.name}_command`,
      events: Object.keys(machine.events).sort().filter(name => machine.events[name].tier === "omnishell"),
    },
    omnishell: spec.omnishell,
    initial: "idle",
    states: Object.fromEntries(["idle", "connecting", "ready", "submitting", "unknown", "awaiting_view", "rejected", "reconnecting", "failed", "closed"].map(phase => [phase, {
      tier: "omnishell", final: phase === "closed", on: phase === "closed" ? {} : phase === "failed" ? {close: on.close, open: on.open} : on,
    }])),
  };
}
