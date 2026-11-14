// A slot: one of several local stacks on one machine at once, of this app or any other, each on
// ports of its own. The same file in every app with a local stack, copied unchanged, and frozen: a
// byte-identity guard (tests/lint.ts, guard-slot) fails an app whose copy differs from
// apps/brawl-chess's, and ci checks one app, not all, when only the shared copies change.
//
// It is a static semaphore, nothing more (docs/queue-research-2026-11-07.md): GitHub's runner pools
// cap who may start, this file only keeps stacks off each other's ports and one `cue` evaluation at a
// time off the machine's memory. It measures nothing: no load, no cores, no memory.
//
//   Ports. Slot n's ports are 33000 + 100·(n-1) onward: the door (CADDY_DOOR_PORT, and
//   CADDY_TLS_HOST_PORT, which ORIGIN names) first, then each ${<VAR>_PORT:-<n>} variable of
//   .bayt/process-compose.yaml by name, then each port it writes as a literal by number. Above the
//   10000-32767 bayt and pronto-identity hash an app's ports into, below macOS's ephemeral 49152: 160
//   slots, none another's, whichever app holds it. The stack runs from the slot's own copy of the app
//   (<pool>/slot-<n>/app): every entry a link to the checkout's, but .bayt/process-compose.yaml,
//   written with the slot's ports. A slot is held as <pool>/slot-<n>/pid (STACK_POOL, else
//   /tmp/pronto-stacks); STACK_SLOT=<n> asks for one by number (a command run under tests/slot.ts is
//   given its slot there; a claim of its own for that number fails at once, naming the holder).
//
//   Weight. A holder declares its weight, a plain count: a launch ½ (it idles), a stack 1, a gate 3
//   (integrate@local with the few `slow` scenarios throttled), a rehearsal 6, a scenarios pass 6,
//   its Premium lane 2; STACK_WEIGHT=<n> or --weight <n> names another. The budget is fixed:
//   STACK_BUDGET, else every core but STACK_RESERVE (3): 15 on an 18-core Mac. A claim is admitted
//   when the weight held, the weight of every live ticket older than its own (they reserve their room)
//   and its own fit the budget; the oldest ticket is admitted on an empty pool whatever it weighs.
//   First come first served, so a heavy claim is never starved by lighter ones. There is no priority,
//   no release lane, no ci lane (STACK_PRIORITY, STACK_RELEASE_LANE, STACK_CI_LANE are accepted and
//   ignored): GitHub's runner pools separate release, gate and ci, not this file.
//
//   Reclaim. Every claim, under the pool's lock, frees what dead pids left: job-<pid> dirs, queue
//   tickets, and slot-<n> dirs whose holder is gone and whose door answers nothing (a stack orphaned
//   by a killed holder keeps its slot until it is down).
//
//   Nested. A claim with a live holder above it (by the process tree, or STACK_JOB, the job that ran
//   it, or STACK_SLOT, the slot of the command it runs under) is admitted at once inside that
//   holder's weight: it adds none (its record says weight 0 and `in=<holder>`), takes no ticket, and
//   a stack still gets a free slot of its own, for its ports. A claim that waited for its own holder
//   would wait for ever (2026-11-07 09:22 BRT).
//
//   Runner jobs first. A claim made inside a GitHub Actions job (GITHUB_ACTIONS=true: ci's checks,
//   gate.yml's gates) is admitted at once on cores, its weight still held: the runner pools are its
//   cap (docs/queue.md), and a job holding a runner while it waits here queues twice. Local claims
//   (a session's own commands) wait behind them. On 2026-11-07 at 23:29 BRT main's ci checks held 6
//   runners while waiting 8th in line behind sessions' local gates. The cue lock still applies.
//
//   Cue lock. A job that names --mem (the cue wrapper, tools/cue-budget/cue: one evaluation of tens
//   of GB; 21 at once ran macOS out of memory on 2026-11-05) takes the cue lock: one such evaluation
//   at a time on the machine, the rest first come first served in <pool>/cue-queue, nested or not. It
//   weighs no cores. --mem-learn <file> writes its peak (GB) there at the end, for the wrapper's next
//   run; --cores-learn is accepted and ignored. A job the memory watchdog (tools/cue-budget) killed
//   under pressure, not for its own size, waits its turn again, once.
//
//   A claim that does not wait (claim(..., false), as a rehearsal's extra lanes) is asked once, in its
//   place in the line, and gives back no slot when it is not admitted then. The wait has no
//   wall-clock limit but progress: a claim fails after STACK_WAIT_MINUTES (else 120) in which no
//   ticket ahead of it left and no weight held dropped.
//
//   deno run -A tests/slot.ts <command...>   the command on a slot, in the slot's copy, with
//                                            APP_URL, ORIGIN and every port variable set
//   deno run -A tests/slot.ts launch         the stack itself, as launch@local, until stopped
//   deno run -A tests/slot.ts launch --watch the same, warm: an edit lands without a relaunch
//   deno run -A tests/slot.ts ./saytw launch@local
//                                            generate and build in the checkout, then launch
//   deno run -A tests/slot.ts --weight <n> --what "<label>" -- <command...>
//                                            claims <n> of the budget, no stack, no ports moved, runs
//                                            the command where it is, releases on exit (a job is held
//                                            as <pool>/job-<pid>)
//
// A launch is a stack kept up for someone to use, and forgotten: three of them held slots for 16 h
// after their sessions were gone. So it ends after an hour (STACK_LAUNCH_TTL seconds, 3600; 0 =
// none): at the deadline it stops its stack, frees the slot, and logs what it stopped to stderr and
// to the slot's owner file. The deadline is <pool>/slot-<n>/deadline (ms since the epoch);
// `renew [<slot n>|<pid>]` pushes it to now + the TTL. Only a launch has one.
//
//   deno run -A tests/slot.ts status         the slots held: holder, what, since when, deadline
//   deno run -A tests/slot.ts renew [n|pid]  a launch's deadline to now + STACK_LAUNCH_TTL
//
// Run inside the app's toolchain (mise exec), which has process-compose, as the verbs are.

const app = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pool = Deno.env.get("STACK_POOL") ?? "/tmp/pronto-stacks";
const budget = Number(Deno.env.get("STACK_BUDGET") ?? Math.max(1, navigator.hardwareConcurrency - Number(Deno.env.get("STACK_RESERVE") ?? 3)));
const asked = Number(Deno.env.get("STACK_SLOT") ?? "0");
const say = (s: string) => console.error(`slot: ${s}`);

// queued and admitted: when the claim asked for its slot and when it got it (ms since the epoch).
export type Slot = { n: number; dir: string; door: number; env: Record<string, string>; release: () => void; queued: number; admitted: number };

// The slot's ports, from the app's process-compose: the variables and the literals, each its own.
export const layout = (compose: string, n: number) => {
  const base = 33000 + 100 * (n - 1);
  const doors = ["CADDY_DOOR_PORT", "CADDY_TLS_HOST_PORT"];
  const vars = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+_PORT):-[0-9]+\}/g)].map((m) => m[1]))].filter((v) => !doors.includes(v)).sort();
  const literals = [...new Set([
    ...compose.matchAll(/[A-Z_]*PORT=([0-9]{4,5})\b/g),
    ...compose.matchAll(/--[a-z-]*port ([0-9]{4,5})\b/g),
    ...compose.matchAll(/(?:localhost|127\.0\.0\.1):([0-9]{4,5})\b/g),
  ].map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (1 + vars.length + literals.length > 100) throw new Error("more than 100 ports in .bayt/process-compose.yaml");
  const ports: Record<string, number> = Object.fromEntries(doors.map((v) => [v, base]));
  vars.forEach((v, i) => ports[v] = base + 1 + i);
  const moved = new Map(literals.map((p, i) => [p, base + 1 + vars.length + i]));
  const text = compose
    .replace(new RegExp(`\\b(${literals.join("|") || "$^"})\\b`, "g"), (p) => String(moved.get(Number(p))))
    .replace(/\$\{([A-Z0-9_]+_PORT):-[0-9]+\}/g, (m, v) => ports[v] ? `\${${v}:-${ports[v]}}` : m);
  return { door: base, ports, moved, text };
};

// The PATH the children get, with mise on it: their commands run through `mise exec`, and without
// it process-compose exits at once. If it isn't on the PATH, the newest (by version, numerically)
// mise-v* that sayt cached has it.
const misePath = (): string => {
  const path = Deno.env.get("PATH") ?? "";
  const has = (dir: string) => { try { return (Deno.statSync(`${dir}/mise`).mode ?? 0) & 0o111; } catch { return 0; } };
  if (path.split(":").some(has)) return path;
  const cache = `${Deno.env.get("HOME")}/Library/Caches/sayt`;
  const version = (name: string) => name.slice(6).split(".").map(Number);
  const newest = (a: string, b: string) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  };
  let dirs: string[] = [];
  try { dirs = [...Deno.readDirSync(cache)].map((e) => e.name).filter((n) => /^mise-v[0-9]/.test(n) && has(`${cache}/${n}`)); } catch { /* none cached */ }
  if (!dirs.length) { console.error("mise not found: run ./saytw once, or add mise to PATH"); Deno.exit(1); }
  return `${cache}/${dirs.sort(newest)[0]}:${path}`;
};

// kill -0 answers "no such process" only for a pid that is gone. A holder another account
// started is alive too, though kill -0 on it fails (EPERM): not ps, which a sandbox cannot spawn
// (setuid), and the reason read in the C locale.
const alive = async (pid: number) => {
  if (pid <= 0) return false;
  const { code, stderr } = await new Deno.Command("kill", { args: ["-0", String(pid)], env: { LC_ALL: "C" }, stderr: "piped" }).output();
  return code === 0 || /not permitted/i.test(new TextDecoder().decode(stderr));
};
const holder = async (name: string) => Number(await Deno.readTextFile(`${pool}/${name}/pid`).catch(() => "0"));
// The weights a holder declares: a launch (idle between the clicks of whoever plays it: 0.32 core on
// average, 0.53 at p90), a stack, a rehearsal, and each lane a rehearsal adds to its own
// (tests/rehearse.ts), a scenarios pass's or Premium's.
export const weights = { launch: 0.5, stack: 1, rehearsal: 6, pass: 6, premium: 2, gate: 3 };
// What a command run under slot.ts weighs when STACK_WEIGHT names none: a launch, a stack, or, for an
// integrate@local whose pages will run throttled, the stack and those pages (weights.pass). It mirrors
// tests/slow.ts: SLOW named (not 0 or empty) throttles every scenario's pages, weights.pass; SLOW unset
// in the local gate (INTEGRATE_LOCAL_DRIVERS=all, not SCENARIOS_ALL) throttles only the scenarios
// marked `slow`, weights.gate.
export const commandWeight = (args: string[], env: Record<string, string | undefined>) => {
  if (args[0] === "launch") return weights.launch;
  if (!(/(^|\/)saytw$/.test(args[0] ?? "") && args[1] === "integrate@local")) return weights.stack;
  const asked = env.SLOW;
  if (asked === undefined) return env.INTEGRATE_LOCAL_DRIVERS === "all" && !env.SCENARIOS_ALL ? weights.gate : weights.stack;
  return asked !== "" && asked !== "0" ? weights.pass : weights.stack;
};
// A holder's record, "<pid> <weight>[ cue][ in=<holder>]", its holder's only while the pid is the
// holder's: a holder that wrote none weighs a stack. A record from before this rule (`mem=<GB>`) is a
// cue holder too, so a copy of slot.ts that is not this one is still counted by the lock.
export const weightOf = (text: string, pid: number) => {
  const [p, w, ...rest] = text.trim().split(" ");
  return p === String(pid) && w !== undefined && w !== "" && Number(w) >= 0
    ? { weight: Number(w), cue: rest.some((x) => x === "cue" || x.startsWith("mem=")) }
    : { weight: weights.stack, cue: false };
};
// A launch's TTL in seconds (STACK_LAUNCH_TTL, else an hour; 0 or less = none), and the deadline it
// gives a claim made or renewed at `now` (ms since the epoch; 0 = none). Only a launch has one.
export const launchTtl = (env: string | undefined = Deno.env.get("STACK_LAUNCH_TTL")) => {
  const t = env === undefined || env.trim() === "" ? 3600 : Number(env);
  return Number.isFinite(t) && t > 0 ? t : 0;
};
export const deadlineOf = (kind: "launch" | "gate" | "job" | "cue", now: number, ttl: number) => kind === "launch" && ttl > 0 ? now + ttl * 1000 : 0;
// A claim is expired when it is a launch with a deadline and the deadline has come.
export const expired = (claim: { kind: "launch" | "gate" | "job" | "cue"; deadline: number }, now: number) =>
  claim.kind === "launch" && claim.deadline > 0 && now >= claim.deadline;
// BRT, as the user reads times.
const brt = (ms: number) => new Date(ms - 3 * 3600_000).toISOString().replace("T", " ").slice(0, 19) + " BRT";
const weighs = async (name: string, pid: number) => weightOf(await Deno.readTextFile(`${pool}/${name}/weight`).catch(() => ""), pid);
const round = (gb: number) => Math.round(gb * 10) / 10;
// The weight the live holders hold, and how many are stacks (a job is no stack).
export const held = (holders: { weight: number; job?: boolean }[]) => ({ live: holders.filter((h) => !h.job).length, used: holders.reduce((n, h) => n + h.weight, 0) });
// The admission rule: a claim of `weight` is admitted when the weight held (`used`) and the weight
// reserved by the tickets older than its own (`ahead`) leave room for it within the `budget`; the
// oldest ticket (`ahead` 0) is admitted on an empty pool whatever its weight.
export const admits = (used: number, weight: number, ahead: number, budget: number) =>
  used + ahead === 0 || used + ahead + weight <= budget;
// The cue lock: one memory-claimed evaluation at a time, first come first served: admitted when no
// live ticket is older than its own (`ahead`) and no live holder holds the lock (`holding`).
export const cueAdmits = (ahead: number, holding: number) => ahead === 0 && holding === 0;
// Which line a claim waits in: "none" inside a live holder (`parent`) with no memory, or inside one
// that holds the cue lock (`insideCue`: the same evaluation's memory, a `cue` its own job runs; waiting
// for the lock its ancestor holds would wait for ever, as two aprende generates did for 70 min on
// 2026-11-07); "cue" for any other memory claim, nested or not; "cores" otherwise.
export const lineOf = (parent: number, mem: number, insideCue = false) =>
  mem > 0 && !(insideCue && parent > 0) ? "cue" : parent > 0 ? "none" : "cores";
// Whether a claim comes from a GitHub Actions job (GITHUB_ACTIONS): admitted at once on cores.
export const runnerJob = (env: string | undefined) => env === "true";
// The cores rule: a nested claim is admitted whatever the room, any other by `admits`.
export const admitsCores = (nested: boolean, used: number, weight: number, ahead: number, budget: number) =>
  nested || admits(used, weight, ahead, budget);
// A slot's directory is stale, to be freed at the next claim, when its holder is gone and nothing
// answers on its door.
export const staleSlot = (holderAlive: boolean, doorAnswers: boolean) => !holderAlive && !doorAnswers;
// A ticket's name: when it was asked for, in ms, and its pid; names sort in the order of the line.
export const ticketOf = (now: number, pid: number) => `${String(now).padStart(15, "0")}-${pid}`;
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : Math.min(n % 10, 4) % 4]}`;
// Held when something answers there, on either loopback.
const answers = (port: number) => Promise.all(["127.0.0.1", "::1"].map((hostname) =>
  Deno.connect({ hostname, port }).then((c) => (c.close(), true), () => false))).then((a) => a.some(Boolean));

// The pool's own lock, held only while a slot is chosen; one older than a minute is a crashed
// chooser's.
const choosing = async <T>(f: () => Promise<T>): Promise<T> => {
  const lock = `${pool}/.choosing`;
  for (;;) {
    try { Deno.mkdirSync(lock); break; } catch { /* held */ }
    const age = Date.now() - ((await Deno.stat(lock).catch(() => undefined))?.mtime?.getTime() ?? Date.now());
    if (age > 60_000) await Deno.remove(lock, { recursive: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return await f(); } finally { await Deno.remove(lock, { recursive: true }).catch(() => {}); }
};

// A slot asked for by number is not waited for when its holder is the asker or above it.
export const heldByAncestor = (holder: number, lineage: number[]) => holder > 0 && lineage.includes(holder);
// A process and its parents, nearest first: one ps of the whole table, not one per level (stops at
// init or a loop). Without ps (a sandbox), the process alone.
const lineage = async (pid: number) => {
  const out = [pid];
  try {
    const { stdout } = await new Deno.Command("ps", { args: ["-A", "-o", "pid=,ppid="], stdout: "piped", stderr: "null" }).output();
    const parent = new Map<number, number>();
    for (const l of new TextDecoder().decode(stdout).split("\n")) {
      const [p, pp] = l.trim().split(/\s+/).map(Number);
      if (p > 0) parent.set(p, pp);
    }
    for (let p = pid; out.length < 64;) {
      const up = parent.get(p) ?? 0;
      if (!(up > 1) || out.includes(up)) break;
      out.push(up); p = up;
    }
  } catch { /* alone */ }
  return out;
};
// The live holder among the processes above a claim (0: none): a claim with one is nested, and its cores are not waited for.
export const nestedUnder = (holders: number[], above: number[]) => holders.find((h) => heldByAncestor(h, above)) ?? 0;

export async function claim(pid?: number, what?: string, weight?: number, wait?: true, job?: boolean, mem?: number): Promise<Slot>;
export async function claim(pid: number, what: string, weight: number, wait: false, job?: boolean, mem?: number): Promise<Slot | undefined>;
export async function claim(pid = Deno.pid, what = Deno.args.join(" "), weight = Number(Deno.env.get("STACK_WEIGHT") ?? weights.stack), wait = true, job = false, mem = 0): Promise<Slot | undefined> {
  await Deno.mkdir(pool, { recursive: true });
  const ancestry = await lineage(pid);
  // STACK_SLOT=<n> names the slot of the command this process runs under (tests/slot.ts <command>): a
  // claim for that number from the command itself would wait for ever, its holder above it. Before the
  // ticket, so the head of the line is never a claim that cannot be admitted.
  if (!job && asked) {
    const held = await holder(`slot-${asked}`);
    if (heldByAncestor(held, ancestry) && await alive(held)) {
      throw new Error(`slot ${asked} (STACK_SLOT) is held by ${held}, this process or one above it: ${what} runs on the slot it was given and takes none of its own, so it is not run under tests/slot.ts (verify@local takes its own slot: run it directly)`);
    }
  }
  // A claim is nested when a live holder is above it: by the process tree (not this process, whose
  // own slot a rehearsal's lanes sit beside), or by the environment when the tree was lost (a daemon):
  // STACK_JOB, the job that ran it, and for a job STACK_SLOT, its slot.
  const above = [...ancestry.slice(1), Number(Deno.env.get("STACK_JOB") ?? 0), job && asked ? await holder(`slot-${asked}`) : 0];
  const live: number[] = [];
  let insideCue = false;
  for await (const e of Deno.readDir(pool)) {
    const h = /^(?:slot|job)-[0-9]+$/.test(e.name) ? await holder(e.name) : 0;
    if (h > 0 && above.includes(h) && await alive(h)) {
      live.push(h);
      if ((await weighs(e.name, h)).cue) insideCue = true;
    }
  }
  const parent = nestedUnder(live, above);
  if (parent) weight = 0;
  const line = lineOf(parent, mem, insideCue);
  // A job (--weight) brings up no stack: no process-compose, no ports, no slot number.
  const compose = job ? "" : await Deno.readTextFile(`${app}/.bayt/process-compose.yaml`);
  let told = "";
  const queued = Date.now();
  const dirOf = line === "cue" ? "cue-queue" : "queue";
  const queue = `${pool}/${dirOf}`;
  const ticket = ticketOf(queued, pid);
  await Deno.mkdir(queue, { recursive: true });
  if (line !== "none") await Deno.writeTextFile(`${queue}/${ticket}`, `${weight} ${what}`);
  const minutes = Number(Deno.env.get("STACK_WAIT_MINUTES") ?? 120);
  let end = Date.now() + minutes * 60_000, fewest = Infinity, lightest = Infinity;
  try {
  for (;;) {
    const got = await choosing(async () => {
      // Reclaim, at every claim: the live tickets of this claim's line older than its own (their
      // weights reserved), the dead ones freed; the live holders, the dead jobs and stale slots freed.
      const older: { name: string; weight: number; what: string }[] = [];
      if (line !== "none") {
        for await (const e of Deno.readDir(queue)) {
          const m = e.name.match(/^[0-9]+-([0-9]+)$/);
          if (!m) continue;
          if (!await alive(Number(m[1]))) { await Deno.remove(`${queue}/${e.name}`).catch(() => {}); continue; }
          if (e.name >= ticket) continue;
          const [w, ...rest] = (await Deno.readTextFile(`${queue}/${e.name}`).catch(() => "")).split(" ");
          older.push({ name: e.name, weight: w !== "" && Number(w) >= 0 ? Number(w) : weights.stack, what: rest.join(" ") });
        }
        older.sort((x, y) => x.name < y.name ? -1 : 1);
      }
      const ahead = older.reduce((n, o) => n + o.weight, 0);
      const where = `${ordinal(older.length + 1)} in line${older.length ? ` behind ${older.at(-1)!.what} (weight ${older.at(-1)!.weight})` : ""}`;
      const holders: { weight: number; cue: boolean; job: boolean }[] = [];
      for await (const e of Deno.readDir(pool)) {
        const m = e.name.match(/^(slot|job)-([0-9]+)$/);
        if (!m) continue;
        const pid = await holder(e.name);
        if (await alive(pid)) holders.push({ ...await weighs(e.name, pid), job: m[1] === "job" });
        else if (m[1] === "job") await Deno.remove(`${pool}/${e.name}`, { recursive: true }).catch(() => {});
        else if (staleSlot(false, await answers(33000 + 100 * (Number(m[2]) - 1)))) await Deno.remove(`${pool}/${e.name}`, { recursive: true }).catch(() => {});
      }
      const { used } = held(holders);
      const why = (s: string) => ({ why: `${where}: ${s}`, ahead: older.length, used });
      if (line === "cue") {
        const holding = holders.filter((h) => h.cue).length;
        if (!cueAdmits(older.length, holding)) return why(`the cue lock: ${holding ? "held" : "free"}, ${older.length} ahead (one cue evaluation at a time)`);
      } else if (!admitsCores(line === "none" || runnerJob(Deno.env.get("GITHUB_ACTIONS")), used, weight, ahead, budget)) {
        return why(`weight ${used} of ${budget} held (STACK_BUDGET)${ahead ? `, ${ahead} reserved by those ahead` : ""}, this needs ${weight}`);
      }
      const tag = `${mem > 0 ? " cue" : ""}${parent ? ` in=${parent}` : ""}`;
      if (job) {
        const dir = `${pool}/job-${pid}`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/weight`, `${pid} ${weight}${tag}`);
        await Deno.writeTextFile(`${dir}/pid`, String(pid));
        await Deno.writeTextFile(`${dir}/owner`, `${pid} ${new Date().toISOString()} ${what} (weight ${weight}${mem > 0 ? ", cue lock" : ""})\n`);
        return { n: 0, dir, door: 0, ports: {}, text: "" };
      }
      const busy: string[] = [];
      for (const n of asked ? [asked] : Array.from({ length: 160 }, (_, i) => i + 1)) {
        if (await alive(await holder(`slot-${n}`))) { busy.push(`${n} held by ${await holder(`slot-${n}`)}`); continue; }
        const { door, ports, moved, text } = layout(compose, n);
        const open = [];
        for (const p of new Set([...Object.values(ports), ...moved.values()])) if (await answers(p)) open.push(p);
        if (open.length) { busy.push(`${n}'s ports ${open.join(", ")} answer, its stack not down`); continue; }
        const dir = `${pool}/slot-${n}`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/weight`, `${pid} ${weight}${tag}`);
        await Deno.writeTextFile(`${dir}/pid`, String(pid));
        await Deno.writeTextFile(`${dir}/owner`, `${pid} ${new Date().toISOString()} ${app} ${what} (weight ${weight})\n`);
        return { n, dir, door, ports, text };
      }
      return why(`slot ${busy.join("; ")}`);
    });
    if (!("why" in got)) {
      const { n, dir, door, ports, text } = got;
      const tail = `${parent ? ` (inside ${parent}: admitted at once, within its weight)` : ""}${mem > 0 ? " (cue lock)" : ""}`;
      if (job) {
        say(`${what}: weight ${weight} of ${budget}${tail}`);
        const release = () => {
          try { Deno.removeSync(dir, { recursive: true }); } catch { /* gone */ }
        };
        return { n, dir, door, env: {}, release, queued, admitted: Date.now() };
      }
      // The slot's copy of the app: links to the checkout, but its process-compose.
      const copy = `${dir}/app`;
      await Deno.remove(copy, { recursive: true }).catch(() => {});
      await Deno.mkdir(`${copy}/.bayt`, { recursive: true });
      for await (const e of Deno.readDir(app)) if (e.name !== ".bayt") await Deno.symlink(`${app}/${e.name}`, `${copy}/${e.name}`);
      for await (const e of Deno.readDir(`${app}/.bayt`)) {
        if (e.name !== "process-compose.yaml") await Deno.symlink(`${app}/.bayt/${e.name}`, `${copy}/.bayt/${e.name}`);
      }
      await Deno.writeTextFile(`${copy}/.bayt/process-compose.yaml`, text);
      const url = `https://localhost:${door}`;
      say(`slot ${n}: ${url}, ports ${door}-${door + 99}, weight ${weight} of ${budget}${tail}, from ${copy}`);
      // mise reads the copy's .mise.toml, which it trusts as the checkout's.
      const trusted = [Deno.env.get("MISE_TRUSTED_CONFIG_PATHS"), copy].filter(Boolean).join(":");
      const env = { ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])), ORIGIN: url, APP_URL: url, STACK_SLOT: String(n), PRONTO_GATE_DIR: app, MISE_TRUSTED_CONFIG_PATHS: trusted };
      const release = () => {
        try { Deno.removeSync(`${dir}/pid`); } catch { /* gone */ }
      };
      return { n, dir: copy, door, env, release, queued, admitted: Date.now() };
    }
    if (!wait) { say(`not taken: ${got.why}`); return undefined; }
    // Said again when the reason changes.
    if (got.why !== told) say(`waiting: ${got.why}`);
    told = got.why;
    // Progress: a ticket ahead left, or the weight held dropped, below the least seen.
    if (got.ahead < fewest || got.used < lightest) end = Date.now() + minutes * 60_000;
    fewest = Math.min(fewest, got.ahead);
    lightest = Math.min(lightest, got.used);
    if (Date.now() > end) throw new Error(`no slot, and the line did not move for ${minutes} minutes: ${got.why}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  } finally {
    if (line !== "none") await Deno.remove(`${queue}/${ticket}`).catch(() => {});
  }
}


// process-compose with its API on a socket in the run's own folder, and its log there, so the
// stack can be brought down whole: a launch stopped by a signal can leave its postgres behind.
export const stack = (slot: Slot, run: string) => {
  const pc = (more: string[]) => ["-U", "-u", `${run}/pc.sock`, "-L", `${run}/process-compose.log`, ...more];
  const env = { ...slot.env, MISE_LOCKED: "0", PATH: misePath() };
  const child = new Deno.Command("process-compose", { args: pc(["-f", ".bayt/process-compose.yaml", "up", "--tui=false"]), cwd: slot.dir, env, stdout: "null", stderr: "null" }).spawn();
  let exited = false;
  child.status.then(() => exited = true);
  const down = async () => {
    await new Deno.Command("process-compose", { args: pc(["down"]), cwd: slot.dir, env, stdout: "null", stderr: "null" }).output();
    const stopped = await Promise.race([child.status.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(exited), 60_000))]);
    if (!stopped) { try { child.kill("SIGTERM"); } catch { /* gone */ } await Promise.race([child.status, new Promise((r) => setTimeout(r, 30_000))]); }
  };
  return { child, pc, env, exited: () => exited, down };
};

// The warm stack's dev loop (launch --watch), as `sayt launch --watch` is the docker stack's: a
// service restarts when a path its develop.watch names changes (bayt.<service>.json, from what
// the cluster marks watched: the shell, its screens, handlers and styles, the messages, the
// migrations). The door copies its statics again as it starts, so a reload shows the edit; the
// database runs its migrations again, each idempotent. A CUE file changed runs generate in the
// checkout first; what it writes into a watched path restarts its service; when the stack's
// own definition changed it says to launch again. Nothing is built again.
export const watch = (slot: Slot, pc: (more: string[]) => string[], env: Record<string, string>) => {
  const services = () => {
    const by = new Map<string, Set<string>>();
    for (const e of Deno.readDirSync(`${app}/.bayt`)) {
      const m = e.name.match(/^bayt\.(.+)\.json$/);
      if (!m) continue;
      let list: { path: string }[] = [];
      try { list = JSON.parse(Deno.readTextFileSync(`${app}/.bayt/${e.name}`))?.compose?.develop?.watch ?? []; } catch { continue; }
      for (const w of list) {
        const p = decodeURIComponent(new URL(w.path, `file://${app}/.bayt/`).pathname).replace(/\/$/, "");
        if (!by.has(p)) by.set(p, new Set());
        by.get(p)!.add(m[1]);
      }
    }
    return by;
  };
  let by = services();
  const pcRun = (more: string[]) => new Deno.Command("process-compose", { args: pc(more).filter((a, i, all) => a !== "-L" && all[i - 1] !== "-L"), cwd: slot.dir, env, stdout: "null", stderr: "piped" }).output();
  const mtime = (p: string) => { try { return Deno.statSync(p).mtime?.getTime() ?? 0; } catch { return 0; } };
  // The CUE files generate itself wrote, at the time it left them: an event on one of them,
  // unchanged since, is generate's own, not an edit, so generate never runs itself again.
  const generated = new Map<string, number>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = Promise.resolve();
  const apply = (first: number) => busy = busy.then(async () => {
    const paths = [...pending];
    pending.clear();
    if (paths.some((p) => p.endsWith(".cue"))) {
      say("watch: CUE changed, generate");
      const start = Date.now();
      const gen = await new Deno.Command("./saytw", { args: ["generate"], cwd: app, stdout: "null", stderr: "null" }).output();
      const walk = (d: string) => {
        for (const e of Deno.readDirSync(d)) {
          const f = `${d}/${e.name}`;
          if (e.isDirectory && !["node_modules", ".bayt", ".task", "cue.mod", ".git"].includes(e.name)) walk(f);
          else if (e.isFile && e.name.endsWith(".cue") && mtime(f) >= start) generated.set(f, mtime(f));
        }
      };
      walk(app);
      for (const [f, t] of generated) if (pending.has(f) && mtime(f) === t) pending.delete(f);
      if (!gen.success) { say(`watch: generate exited ${gen.code}, the stack left as it was`); return; }
      say(`watch: generate done, ${Date.now() - first} ms after the edit; what it wrote restarts what serves it`);
      // A definition changed is a relaunch (seconds, on a slot): process-compose 1.122's project
      // update lost the database's place in the run order after a restart and took the stack down.
      const { text } = layout(await Deno.readTextFile(`${app}/.bayt/process-compose.yaml`), slot.n);
      if (text !== await Deno.readTextFile(`${slot.dir}/.bayt/process-compose.yaml`)) {
        say("watch: the stack's definition changed (a service, a port or a static added): stop this launch and launch again");
      }
      by = services();
    }
    const restart = new Set<string>();
    for (const p of paths) for (const [w, s] of by) if (p === w || p.startsWith(`${w}/`)) s.forEach((x) => restart.add(x));
    for (const s of restart) {
      const r = await pcRun(["process", "restart", s]);
      say(r.success ? `watch: ${s} restarted, ${Date.now() - first} ms after the edit` : `watch: ${s} failed to restart: ${new TextDecoder().decode(r.stderr).trim()}`);
    }
  }).catch((e) => say(`watch: ${e?.message ?? e}; still watching`));
  // The app's folder, not each file: an editor that saves by rename replaces the file a watch held.
  // Events keep coming while generate runs: what it writes into a watched path restarts its service.
  const watcher = Deno.watchFs(app, { recursive: true });
  say(`watch: ${by.size} paths of ${new Set([...by.values()].flatMap((s) => [...s])).size} services, and the app's CUE`);
  let first = 0;
  (async () => {
    for await (const ev of watcher) {
      if (ev.kind === "access") continue;
      const hit = ev.paths.filter((p) => !p.includes("/.bayt/") && !p.includes("/.task/") && !p.includes("/node_modules/") && !p.includes("/cue.mod/") &&
        (p.endsWith(".cue") ? generated.get(p) !== mtime(p) : [...by.keys()].some((w) => p === w || p.startsWith(`${w}/`))));
      if (!hit.length) continue;
      if (!pending.size) first = Date.now();
      hit.forEach((p) => pending.add(p));
      clearTimeout(timer);
      timer = setTimeout(() => apply(first), 150);
    }
  })().catch((e) => say(`watch: stopped: ${e?.message ?? e}`));
  return () => watcher.close();
};

// What a process holds in memory now (GB), its resident set; 0 once it is gone.
const residentOf = async (pid: number) => {
  const r = await new Deno.Command("ps", { args: ["-o", "rss=", "-p", String(pid)], stdout: "piped", stderr: "null" }).output().catch(() => undefined);
  return (Number(new TextDecoder().decode(r?.stdout ?? new Uint8Array()).trim()) || 0) / 2 ** 20;
};
// Why the memory watchdog (tools/cue-budget/watchdog.sh) killed a pid, if it did: "over" (its own
// size, past the ceiling) or "pressure" (the machine's, it the largest).
const killedFor = (pid: number) => {
  const dir = Deno.env.get("CUE_WATCHDOG_DIR") ?? `${Deno.env.get("HOME")}/.cache/pronto/cue-watchdog`;
  // Read once and removed: a later process given the same pid is not taken for it.
  try { const why = Deno.readTextFileSync(`${dir}/killed/${pid}`).trim().split(" ")[0]; Deno.removeSync(`${dir}/killed/${pid}`); return why; } catch { return ""; }
};


if (import.meta.main && ["--weight", "--what", "--mem", "--mem-learn", "--cores-learn"].includes(Deno.args[0] ?? "")) {
  // A job: its weight claimed (--mem: the cue lock instead), no stack, the command run where it is.
  const split = Deno.args.indexOf("--");
  const opts = Deno.args.slice(0, split < 0 ? Deno.args.length : split);
  const cmd = split < 0 ? [] : Deno.args.slice(split + 1);
  const opt = (name: string) => opts[opts.indexOf(name) + 1];
  const mem = opts.includes("--mem") ? Number(opt("--mem")) : 0;
  const learn = opts.includes("--mem-learn") ? opt("--mem-learn") : undefined;
  // --cores-learn is accepted and ignored: nothing weighs cores by what they used any more.
  const weight = Number(opts.includes("--weight") ? opt("--weight") : Deno.env.get("STACK_WEIGHT") ?? (mem > 0 ? 0 : weights.stack));
  if (!cmd.length || !(mem >= 0) || !(weight > 0 || (weight === 0 && mem > 0))) {
    console.error('usage: deno run -A tests/slot.ts --weight <n> [--mem <GB>] [--mem-learn <file>] --what "<label>" -- <command...>');
    Deno.exit(2);
  }
  const what = opts.includes("--what") ? opt("--what") : cmd.join(" ");
  let slot: Slot | undefined, child: Deno.ChildProcess | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, async () => {
      if (child) {
        const c = child;
        try { c.kill("SIGTERM"); } catch { /* gone */ }
        const gone = await Promise.race([c.status.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 120_000))]);
        // Its weight is given back only once it is not running: one that ignored the signal is killed.
        if (!gone) try { c.kill("SIGKILL"); } catch { /* gone */ }
      }
      slot?.release();
      Deno.exit(130);
    });
  }
  let peak = 0, status: Deno.CommandStatus;
  for (let attempt = 1; ; attempt++) {
    slot = await claim(Deno.pid, what, weight, true, true, mem);
    const c = child = new Deno.Command(cmd[0], { args: cmd.slice(1), env: { STACK_JOB: String(Deno.pid) }, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).spawn();
    // What it holds, every second, for its peak: the next run's --mem and a watchdog kill's verdict.
    let running = true;
    const sample = async () => { const rss = await residentOf(c.pid); if (running) peak = Math.max(peak, rss); };
    const sampler = learn ? (sample(), setInterval(sample, 1000)) : undefined;
    status = await c.status;
    running = false;
    clearInterval(sampler);
    child = undefined;
    slot.release();
    slot = undefined;
    if (mem > 0 && attempt === 1 && status.signal === "SIGKILL" && killedFor(c.pid) === "pressure") {
      say(`${what}: the memory watchdog killed it under the machine's pressure at ${round(peak)} GB; in line again`);
      continue;
    }
    break;
  }
  // Its peak, for the next run's claim. A run that failed or was killed may have stopped before its
  // peak (a missing file, a bad flag): its peak only raises what was learned. One that ended before
  // a sample held next to nothing: learned as such, so it runs outside the lock.
  if (learn) {
    if (!(peak > 0)) peak = 0.05;
    const before = status.success ? 0 : Number((await Deno.readTextFile(learn).catch(() => "")).split(" ")[0]) || 0;
    await Deno.mkdir(learn.replace(/\/[^/]*$/, ""), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(learn, `${round(Math.max(peak, before))} ${what}\n`).catch(() => {});
  }
  Deno.exit(status.code);
}

if (import.meta.main) {
  if (!Deno.args.length) { console.error("usage: deno run -A tests/slot.ts launch [--watch] | <command...> | status | renew [n|pid] | --weight <n> --what <label> -- <command...>"); Deno.exit(2); }
  if (Deno.args[0] === "status" || Deno.args[0] === "renew") {
    const asked = Deno.args[1] === undefined ? 0 : Number(Deno.args[1]);
    let found = 0;
    const names: string[] = [];
    try { for (const e of Deno.readDirSync(pool)) if (/^(slot|job)-[0-9]+$/.test(e.name)) names.push(e.name); } catch { /* no pool */ }
    for (const name of names.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))) {
      const pid = await holder(name);
      if (!await alive(pid)) continue;
      const owner = (await Deno.readTextFile(`${pool}/${name}/owner`).catch(() => "")).trim();
      const deadline = Number(await Deno.readTextFile(`${pool}/${name}/deadline`).catch(() => "0"));
      if (Deno.args[0] === "status") { console.log(`${name} pid ${pid} ${owner}${deadline ? ` deadline ${brt(deadline)}` : ""}`); continue; }
      if (!deadline || (asked && asked !== pid && `slot-${asked}` !== name)) continue;
      const next = deadlineOf("launch", Date.now(), launchTtl());
      if (!next) { say(`${name}: STACK_LAUNCH_TTL is 0, no deadline to push`); continue; }
      await Deno.writeTextFile(`${pool}/${name}/deadline`, String(next));
      say(`${name} (pid ${pid}) renewed to ${brt(next)}`);
      found++;
    }
    if (Deno.args[0] === "renew" && !found) { console.error("no live launch with a deadline" + (asked ? ` for ${asked}` : "")); Deno.exit(1); }
    Deno.exit(0);
  }
  const args = /(^|\/)saytw$/.test(Deno.args[0]) && Deno.args[1] === "launch@local" ? ["launch", ...Deno.args.slice(2)] : Deno.args;
  if (args !== Deno.args) {
    for (const verb of ["generate", "build"]) {
      say(`${verb}, in the checkout, as launch@local does before its stack`);
      const { code } = await new Deno.Command("./saytw", { args: [verb], cwd: app, stdin: "null", stdout: "inherit", stderr: "inherit" }).output();
      if (code) Deno.exit(code);
    }
  }
  const slot = await claim(Deno.pid, args.join(" "), Number(Deno.env.get("STACK_WEIGHT") ?? commandWeight(args, Deno.env.toObject())));
  let stopping: (() => Promise<void>) | undefined;
  // Where the command was run from: the owner dir an expiry names (the cwd, not the slot's copy).
  const checkout = Deno.cwd();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, async () => { await stopping?.(); slot.release(); await Deno.remove(`${slot.dir.replace(/\/app$/, "")}/deadline`).catch(() => {}); Deno.exit(130); });
  }
  let code: number;
  if (args[0] === "launch") {
    const tmp = await Deno.makeTempDir({ prefix: "slot." });
    const s = stack(slot, tmp);
    const unwatch = args.includes("--watch") ? watch(slot, s.pc, s.env) : undefined;
    stopping = async () => { say("the stack going down"); unwatch?.(); await s.down(); };
    // The launch ends after its TTL unless renewed (`renew`): the deadline is a file beside the slot's pid.
    const slotDir = slot.dir.replace(/\/app$/, ""), started = brt(Date.now());
    const deadlineFile = `${slotDir}/deadline`;
    const first = deadlineOf("launch", Date.now(), launchTtl());
    if (first) await Deno.writeTextFile(deadlineFile, String(first));
    say(`the stack coming up at ${slot.env.APP_URL}, its log ${tmp}/process-compose.log; stop it with a signal to ${Deno.pid}${first ? `; it ends at ${brt(first)} unless renewed (deno run -A tests/slot.ts renew ${slot.n})` : ""}`);
    if (first) {
      const timer = setInterval(async () => {
        const deadline = Number(await Deno.readTextFile(deadlineFile).catch(() => "0"));
        if (!expired({ kind: "launch", deadline }, Date.now())) return;
        clearInterval(timer);
        const line = `the launch timed out and is stopped: ${args.join(" ")}, slot ${slot.n}, pid ${Deno.pid}, started ${started}, owner dir ${checkout}`;
        say(line);
        await Deno.writeTextFile(`${slotDir}/owner`, `${line}\n`, { append: true }).catch(() => {});
        await stopping?.();
        slot.release();
        await Deno.remove(deadlineFile).catch(() => {});
        Deno.exit(0);
      }, Number(Deno.env.get("STACK_LAUNCH_POLL_MS") ?? 5000));
      Deno.unrefTimer(timer);
    }
    code = (await s.child.status).code;
    if (code === 0) await Deno.remove(tmp, { recursive: true }).catch(() => {});
    else console.error((await Deno.readTextFile(`${tmp}/process-compose.log`).catch(() => "")).split("\n").slice(-40).join("\n"));
  } else {
    const [cmd, ...rest] = args;
    // Not ORIGIN or APP_URL: a command that brings a stack up (integrate-local.ts) moves every port to
    // a free one, the door's too, and the stack's default origin follows its door; the slot's would name
    // a door nothing binds.
    const { ORIGIN: _o, APP_URL: _u, ...ports } = slot.env;
    const child = new Deno.Command(cmd, { args: rest, cwd: slot.dir, env: { ...ports, PATH: misePath() }, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).spawn();
    // Its own stack comes down on its own signal handler (integrate-local.ts and rehearse.ts have one).
    stopping = async () => { try { child.kill("SIGTERM"); } catch { /* gone */ } await Promise.race([child.status, new Promise((r) => setTimeout(r, 120_000))]); };
    code = (await child.status).code;
  }
  slot.release();
  await Deno.remove(`${slot.dir.replace(/\/app$/, "")}/deadline`).catch(() => {});
  Deno.exit(code);
}
