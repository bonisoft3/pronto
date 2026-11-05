// A slot: one of several local stacks on one machine at once, of this app or any other, each on
// ports of its own. The same file in every app with a local stack, copied unchanged. Every stack binds the ports .bayt/process-compose.yaml names: each `${<VAR>_PORT:-<n>}`,
// which a variable moves, and a few the plugins write as literals (the identity broker's front,
// the billing broker, flagd's evaluation, management and sync), which nothing moves. So two stacks
// of the app, from two checkouts, collide, and the second's migrations can land in the first's
// database. A slot moves all of them:
//
//   slot n's ports are 33000 + 100·(n-1) onward: the door (CADDY_DOOR_PORT, and
//   CADDY_TLS_HOST_PORT, which ORIGIN names) first, then each variable by name, then each
//   literal by number. Above the 10000-32767 bayt and pronto-identity hash an app's ports into,
//   below macOS's ephemeral 49152 (integrate@local's fresh ports): 160 slots, none another's,
//   whichever app holds it, since every app's stacks share the one pool.
//
// The stack runs from the slot's own copy of the app (<pool>/slot-<n>/app): every entry a link
// to the checkout's, but .bayt/process-compose.yaml, written with the slot's ports for its
// defaults and its literals. Any verb run there brings its stack up on the slot: integrate@local
// (pronto's integrate-local.ts reads that file), a launch (below), verify@local
// (tests/rehearse.ts, which takes a slot of its own).
//
// The pool: the machine's cores, shared by every app's stacks, as a budget of weight
// (STACK_BUDGET, else every core but STACK_RESERVE, 3: 15 on an 18-core Mac). The reserve is
// for what runs outside the pool (the Claude app and its sessions, WindowServer, other work),
// measured at 2.1 cores on average and 2.9 at p90 beside a rehearsal: a budget of every core
// left that work none, and the machine saturated. A holder declares its weight, the cores it
// keeps busy: a launch ½ (it idles), a plain stack (integrate@local, the scenarios once) 1, a rehearsal
// (verify@local: integrate@local, then a scenarios pass, its throttled pages and the stack) 6,
// and each lane it adds by what the lane runs (weights, below); STACK_WEIGHT=<n> names another.
// One is admitted while the weights held, its own added, stay within the budget (the first
// always is); STACK_SLOTS=<n>, when set, also caps the count. Why these numbers:
// apps/brawl-chess/README.md's "Several stacks at once". A slot is held as <pool>/slot-<n>/pid,
// its weight beside it (STACK_POOL, else /tmp/pronto-stacks). A stack on the app's own ports (a
// plain launch@local) is outside the pool and holds no slot. A slot is taken when its holder is
// gone and nothing answers on its ports (a stack orphaned by a killed holder keeps its slot until
// it is down); STACK_SLOT=<n> asks for one by number and waits for it.
//
// A claim that does not wait (claim(..., false), as a rehearsal's extra lanes take theirs) is
// asked once, in its place in the line, and gives back no slot when it is not admitted then: what
// it would have run, its holder runs on a slot it already has.
//
// A release is never blocked or slowed by pull request work: a claim with STACK_PRIORITY=release
// (release-cron's rehearsal and its lanes) is in line ahead of every claim without it, and counts
// only the weight release holders hold (and the release tickets ahead), so it is admitted whatever
// the pull requests' gates and launches hold, the budget and STACK_SLOTS alike; a claim without it
// still counts everything, so no new plain stack starts while a release holds its room. A holder
// records `release` beside its weight. While this process holds a release slot, every ~5 s it puts
// the browsers (Chrome, chrome-headless-shell) in each live plain holder's process tree to
// background priority (`taskpolicy -b -p`: the lowest CPU tier, I/O and timers throttled), so the
// release gets the cores its pages would spin; the last release slot given back restores them
// (`taskpolicy -B -p`). Only the browsers: a whole tree demoted (its database, door and probes too)
// starved a pull request's stack until its probes were killed and its door refused, and its gate
// failed; its pages only run slower.
//
// A release holds the machine: while release-cron runs a release it keeps ~/.cache/pronto/release-active
// (RELEASE_ACTIVE names another), one line of JSON, {"app","pid","started","phase"}, phase one of
// slot, rehearse, release, confirm. Written by release-cron as the run enters its slot, updated at each
// step, removed when the run ends. A file whose pid is gone (kill -0) is stale: ignored, and deleted
// here. While it is live a claim without STACK_PRIORITY=release is not admitted, whatever room the
// pool has: it waits in line, says why, and looks again every 30 s; one with it is admitted as above,
// and holders already running keep their slots. The wait for a release is not a wedge: it does not
// count against STACK_WAIT_MINUTES.
//
// Heavy work that is not a stack (a gate, a build, a local-model or GPU job, in any app) claims
// its weight the same way and runs on the pool's budget, so the machine as a whole is capped:
//
//   deno run -A tests/slot.ts --weight <n> --what "<label>" -- <command...>
//                                            claims <n> of the budget, with no stack and no ports
//                                            moved, runs the command where it is, releases on exit
//
// (--what defaults to the command; STACK_WEIGHT=<n> names the weight when --weight is left out; a
// job is held as <pool>/job-<pid> and is not held back by STACK_SLOTS, a cap on stacks.) A job that is a series of
// units claims each unit separately, so the release check falls between units.
//
// Memory is the pool's second budget, for work whose cost is memory, not cores: a CUE evaluation
// of a large spec holds tens of GB (aprende's 17 GB for 52 s), and on 2026-11-05 21 of them at
// once held 210 GB of a 128 GB Mac until macOS ran out of memory and swap. A job that names
// --mem <GB> is admitted only while the memory every holder claimed, the memory the tickets ahead
// reserve and its own fit in the memory budget (STACK_MEM_BUDGET GB, else the machine's RAM but
// STACK_MEM_RESERVE, 32 GB, for the stacks, browsers and sessions outside it), and while the
// memory the machine has available, less what the holders claimed and do not hold yet, leaves
// STACK_MEM_HEADROOM (8 GB) beside it; the oldest is admitted when no memory is claimed, so a spec
// larger than the budget still runs, alone. Such a job weighs no cores unless it says so
// (--weight 0, the default with --mem): it runs inside gates and stacks that hold cores already,
// and a claim of cores there would wait on its own holder. Nor does it wait for a release: the
// release's own evaluations are in line ahead of it, and memory counts every holder, the release's
// and the pull requests' alike. While it runs, its holder records what it holds (rss=, every
// second) and raises its claim when it holds more, so the next claim sees the truth; --mem-learn
// <file> writes its peak (GB) there at the end, for the next run's --mem (tools/cue-budget's cue
// wrapper does that for every cue evaluation). A job the memory watchdog (tools/cue-budget) killed
// under pressure, not for its own size, waits its turn again with its peak as its claim, once.
//
// The queue: a claim that has to wait is in line, first come first served, or a heavy one would
// never get its room, every plain stack that fits being let in ahead of it. Each claim registers
// a ticket at the start, <pool>/queue/<time>-<pid> holding its weight and what it runs, and
// removes it when it has a slot, fails or is signalled (one whose pid is gone is ignored and
// swept). A claim is admitted while the weights held, the weights of every ticket older than its
// own (they reserve their room) and its own stay within the budget, so a lighter claim still
// backfills around a waiting rehearsal when the room is there for both, but never into the
// rehearsal's. The oldest ticket is admitted on an empty pool whatever its weight. The wait has no
// wall-clock limit but progress: a claim fails after STACK_WAIT_MINUTES (else 120) in which no
// ticket ahead of it left and no weight held dropped, so a rehearsal behind others, each about
// twenty minutes, waits as long as the line moves, and one behind a wedge does not wait for ever.
//
//   deno run -A tests/slot.ts <command...>   the command on a slot, in the slot's copy, with
//                                            APP_URL, ORIGIN and every port variable set
//   deno run -A tests/slot.ts launch         the stack itself, as launch@local, until stopped
//   deno run -A tests/slot.ts launch --watch the same, warm: an edit lands without a relaunch
//                                            (watch, below)
//   deno run -A tests/slot.ts ./saytw launch@local
//                                            generate and build in the checkout, then launch:
//                                            launch@local run in the copy would generate there,
//                                            writing the copy's process-compose over with the
//                                            app's own literals, and two slots' identity brokers
//                                            would share one port
//
// Run inside the app's toolchain (mise exec), which has process-compose, as the verbs are.

const app = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pool = Deno.env.get("STACK_POOL") ?? "/tmp/pronto-stacks";
const budget = Number(Deno.env.get("STACK_BUDGET") ?? Math.max(1, navigator.hardwareConcurrency - Number(Deno.env.get("STACK_RESERVE") ?? 3)));
const cap = Number(Deno.env.get("STACK_SLOTS") ?? Infinity);
const asked = Number(Deno.env.get("STACK_SLOT") ?? "0");
const GB = 2 ** 30;
// Read when a claim needs it, not as the module loads: the unit tests import it without --allow-sys.
const memBudget = () => Number(Deno.env.get("STACK_MEM_BUDGET") ?? Math.max(1, Deno.systemMemoryInfo().total / GB - Number(Deno.env.get("STACK_MEM_RESERVE") ?? 32)));
const memHeadroom = Number(Deno.env.get("STACK_MEM_HEADROOM") ?? 8);
const say = (s: string) => console.error(`slot: ${s}`);

// queued and admitted: when the claim asked for its slot and when it got it (ms since the epoch).
// hold: a job's record of the memory it claims and holds (GB), for the claims after it.
export type Slot = { n: number; dir: string; door: number; env: Record<string, string>; release: () => void; queued: number; admitted: number; hold?: (mem: number, rss: number) => void };

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
// The weights a holder declares (the README's measures): a launch (idle between the clicks of
// whoever plays it: 0.32 core on average, 0.53 at p90), a stack, a rehearsal, and each lane a
// rehearsal adds to its own (tests/rehearse.ts: one more stack and the throttled pages of the
// check it runs), a scenarios pass's or Premium's. A throttled page spins about a core whatever
// it does (Chrome's throttle busy-waits), so a check weighs its pages.
export const weights = { launch: 0.5, stack: 1, rehearsal: 6, pass: 6, premium: 2 };
// A slot's weight, "<pid> <weight>[ release][ mem=<GB> rss=<GB>]", its holder's only while the pid
// is the holder's: a holder that wrote none (a slot.ts before weights) weighs a stack, one that wrote
// two fields (before releases) is not a release, and one without mem= claims no memory.
export const weightOf = (text: string, pid: number) => {
  const [p, w, ...rest] = text.trim().split(" ");
  const field = (k: string) => Number(rest.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1)) || 0;
  return p === String(pid) && w !== undefined && w !== "" && Number(w) >= 0
    ? { weight: Number(w), release: rest.includes("release"), mem: field("mem"), rss: field("rss") }
    : { weight: weights.stack, release: false, mem: 0, rss: 0 };
};
const weighs = async (name: string, pid: number) => weightOf(await Deno.readTextFile(`${pool}/${name}/weight`).catch(() => ""), pid);
// The memory rule: a claim of `mem` GB fits when the memory the holders claimed (`held`, each its
// claim and what it holds now), the memory reserved by the tickets ahead (`ahead`) and its own stay
// within the `budget`, and the memory the machine has `available`, less what the holders claimed
// and do not hold yet and what is reserved ahead, leaves `headroom` beside it. With no memory
// claimed or reserved, it fits whatever it needs.
export const fitsMemory = (held: { mem: number; rss: number }[], mem: number, ahead: number, budget: number, available: number, headroom: number) => {
  const used = held.reduce((n, h) => n + h.mem, 0);
  const pending = held.reduce((n, h) => n + Math.max(0, h.mem - h.rss), 0);
  return used + ahead === 0 || (used + ahead + mem <= budget && available - pending - ahead - mem >= headroom);
};
const round = (gb: number) => Math.round(gb * 10) / 10;
// What a claim counts of the live holders: all of them, or, for a release, only the releases (the
// pull requests' weight and slots do not count against it): their number and their weight.
export const counted = (holders: { weight: number; release: boolean; job?: boolean }[], release: boolean) => {
  const mine = holders.filter((h) => h.release || !release);
  return { live: mine.filter((h) => !h.job).length, used: mine.reduce((n, h) => n + h.weight, 0) };
};
// The release-active file's text as a record, or nothing when it is not one: an app, a pid and a phase.
export const activeOf = (text: string) => {
  try {
    const a = JSON.parse(text);
    const phases = ["slot", "rehearse", "release", "confirm"];
    return typeof a?.app === "string" && Number.isInteger(a.pid) && a.pid > 0 && phases.includes(a.phase)
      ? { app: a.app as string, pid: a.pid as number, started: String(a.started ?? ""), phase: a.phase as string } : null;
  } catch { return null; }
};
// A claim waits for the release in progress unless it is the release's own.
export const waitsForRelease = (release: boolean, active: boolean) => active && !release;
const activeFile = Deno.env.get("RELEASE_ACTIVE") ?? `${Deno.env.get("HOME")}/.cache/pronto/release-active`;
// The live release, if any; a file that is not one or whose pid is gone is stale and removed.
const releasing = async () => {
  const text = await Deno.readTextFile(activeFile).catch(() => "");
  if (!text) return undefined;
  const a = activeOf(text);
  if (a && await alive(a.pid)) return a;
  if (await Deno.readTextFile(activeFile).catch(() => "") === text) await Deno.remove(activeFile).catch(() => {});
  return undefined;
};
// The admission rule: a claim of `weight` is admitted when the weight held (`used`) and the weight
// reserved by the tickets older than its own (`ahead`) leave room for it within the `budget`; the
// oldest ticket (`ahead` 0) is admitted on an empty pool whatever its weight.
export const admits = (used: number, weight: number, ahead: number, budget: number) =>
  used + ahead === 0 || used + ahead + weight <= budget;
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

// A ticket's name: when it was asked for, in ms, and its pid; a release's dated 10^12 ms early.
export const ticketOf = (now: number, pid: number, release: boolean) => `${String(now - (release ? 1e12 : 0)).padStart(15, "0")}-${pid}`;

// Pull request work yields to a release: while this process holds a release slot (`yielding(1)` as
// one is taken, `yielding(-1)` as one is given back), a sweep every ~5 s demotes the browsers in the
// process tree of each live plain holder to background priority, those not demoted yet; the last slot given
// back restores every pid demoted. One sweeper per process, whatever the slots it holds. Any
// failure (ps, taskpolicy, a pid gone) is ignored: the release then runs as before.
const demoted = new Set<number>();
let holds = 0, sweeper: ReturnType<typeof setInterval> | undefined;
const policy = (flag: string, pids: number[]) => Promise.all(pids.map((p) =>
  new Deno.Command("taskpolicy", { args: [flag, "-p", String(p)], stdout: "null", stderr: "null" }).output().then((r) => r.success, () => false)));
const sweep = async () => {
  try {
    const kids = new Map<number, number[]>(), parent = new Map<number, number>(), browser = new Set<number>();
    const ps = await new Deno.Command("ps", { args: ["-A", "-o", "pid=,ppid=,comm="], stdout: "piped", stderr: "null" }).output();
    for (const l of new TextDecoder().decode(ps.stdout).split("\n")) {
      const [, pid, ppid, comm = ""] = l.match(/^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/) ?? [];
      const p = Number(pid), pp = Number(ppid);
      if (p > 0) { parent.set(p, pp); kids.set(pp, [...kids.get(pp) ?? [], p]); if (/chrom|headless_shell/i.test(comm)) browser.add(p); }
    }
    const mine = new Set<number>();
    for (let p = Deno.pid; p > 0 && !mine.has(p); p = parent.get(p) ?? 0) mine.add(p);
    const todo = new Set<number>();
    for await (const e of Deno.readDir(pool)) {
      const m = e.name.match(/^(?:slot|job)-[0-9]+$/);
      const pid = m ? await holder(e.name) : 0;
      if (!m || !await alive(pid) || (await weighs(e.name, pid)).release) continue;
      for (const q = [pid]; q.length;) { const p = q.pop()!; if (!mine.has(p) && !todo.has(p)) { todo.add(p); q.push(...kids.get(p) ?? []); } }
    }
    const fresh = [...todo].filter((p) => browser.has(p) && !demoted.has(p));
    (await policy("-b", fresh)).forEach((ok, i) => ok && demoted.add(fresh[i]));
  } catch { /* quietly */ }
};
const yielding = (by: 1 | -1) => {
  holds += by;
  if (holds === 1 && by === 1) { sweeper = setInterval(sweep, 5000); sweep(); Deno.unrefTimer(sweeper); }
  if (holds === 0) {
    clearInterval(sweeper);
    sweeper = undefined;
    const pids = [...demoted];
    demoted.clear();
    // Synchronous, so it also runs as the process exits.
    for (const p of pids) try { new Deno.Command("taskpolicy", { args: ["-B", "-p", String(p)], stdout: "null", stderr: "null" }).outputSync(); } catch { /* gone */ }
  }
};
addEventListener("unload", () => { if (holds > 0) { holds = 1; yielding(-1); } });

export async function claim(pid?: number, what?: string, weight?: number, wait?: true, job?: boolean, mem?: number): Promise<Slot>;
export async function claim(pid: number, what: string, weight: number, wait: false, job?: boolean, mem?: number): Promise<Slot | undefined>;
export async function claim(pid = Deno.pid, what = Deno.args.join(" "), weight = Number(Deno.env.get("STACK_WEIGHT") ?? weights.stack), wait = true, job = false, mem = 0): Promise<Slot | undefined> {
  await Deno.mkdir(pool, { recursive: true });
  const isRelease = Deno.env.get("STACK_PRIORITY") === "release";
  // A job (--weight) brings up no stack: no process-compose, no ports, no slot number.
  const compose = job ? "" : await Deno.readTextFile(`${app}/.bayt/process-compose.yaml`);
  let told = "";
  const queued = Date.now();
  // The ticket: its name orders the line. A release's (STACK_PRIORITY=release, release-cron's
  // rehearsal and its lanes) is dated 10^12 ms early, so it sorts ahead of every other ticket, in
  // this slot.ts and in a copy from before priorities alike, and releases keep their own order.
  const queue = `${pool}/queue`;
  const ticket = ticketOf(Date.now(), pid, isRelease);
  await Deno.mkdir(queue, { recursive: true });
  await Deno.writeTextFile(`${queue}/${ticket}`, `${weight}${mem > 0 ? ` mem=${round(mem)}` : ""} ${what}`);
  const minutes = Number(Deno.env.get("STACK_WAIT_MINUTES") ?? 120);
  let end = Date.now() + minutes * 60_000, fewest = Infinity, lightest = Infinity, leanest = Infinity;
  try {
  for (;;) {
    const got = await choosing(async () => {
      // The line: the live tickets older than this one, their weights reserved.
      const older: { name: string; weight: number; mem: number; what: string }[] = [];
      for await (const e of Deno.readDir(queue)) {
        const m = e.name.match(/^[0-9]+-([0-9]+)$/);
        if (!m || e.name >= ticket) continue;
        if (!await alive(Number(m[1]))) { await Deno.remove(`${queue}/${e.name}`).catch(() => {}); continue; }
        const [w, ...what] = (await Deno.readTextFile(`${queue}/${e.name}`).catch(() => "")).split(" ");
        const mm = what[0]?.startsWith("mem=") ? Number(what.shift()!.slice(4)) || 0 : 0;
        older.push({ name: e.name, weight: w !== "" && Number(w) >= 0 && (Number(w) > 0 || mm > 0) ? Number(w) : weights.stack, mem: mm, what: what.join(" ") });
      }
      older.sort((x, y) => x.name < y.name ? -1 : 1);
      const ahead = older.reduce((n, o) => n + o.weight, 0);
      const memAhead = older.reduce((n, o) => n + o.mem, 0);
      const line = `${ordinal(older.length + 1)} in line${older.length ? ` behind ${older.at(-1)!.what} (weight ${older.at(-1)!.weight})` : ""}`;
      const holders: { weight: number; release: boolean; job: boolean; mem: number; rss: number }[] = [];
      for await (const e of Deno.readDir(pool)) {
        const m = e.name.match(/^(slot|job)-[0-9]+$/);
        const pid = m ? await holder(e.name) : 0;
        if (m && await alive(pid)) holders.push({ ...await weighs(e.name, pid), job: m[1] === "job" });
        else if (m?.[1] === "job") await Deno.remove(`${pool}/${e.name}`, { recursive: true }).catch(() => {});
      }
      const { live, used } = counted(holders, isRelease);
      const releasePhase = await releasing();
      // Memory counts every holder, a release's and a pull request's alike: it is the machine's.
      const memUsed = holders.reduce((n, h) => n + h.mem, 0);
      const why = (s: string) => ({ why: `${line}: ${s}`, ahead: older.length, used, memUsed, release: false });
      // A release holds the machine: nothing without its priority starts until it is over, but a
      // job that claims memory and no cores.
      if (releasePhase && weight > 0 && waitsForRelease(isRelease, true)) return { ...why(`the release of ${releasePhase.app} holds the machine (${releasePhase.phase}, run ${releasePhase.pid}, since ${releasePhase.started})`), release: true };
      // The cap counts those ahead too, so a younger claim never takes the slot a waiter is owed.
      if (!job && live + older.length >= cap) return why(`${live} stacks up${older.length ? `, ${older.length} ahead` : ""}, the cap (STACK_SLOTS=${cap})`);
      if (mem > 0) {
        const available = Deno.systemMemoryInfo().available / GB;
        if (!fitsMemory(holders, mem, memAhead, memBudget(), available, memHeadroom)) {
          return why(`memory: ${round(memUsed)} GB of ${round(memBudget())} claimed${memAhead ? `, ${round(memAhead)} reserved by those ahead` : ""}, ${round(available)} GB available, this needs ${round(mem)} (STACK_MEM_BUDGET, STACK_MEM_HEADROOM)`);
        }
      }
      if (weight > 0 && !admits(used, weight, ahead, budget)) return why(`weight ${used} of ${budget} held${ahead ? `, ${ahead} reserved by those ahead` : ""}, this needs ${weight} (STACK_BUDGET)`);
      if (job) {
        const dir = `${pool}/job-${pid}`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/weight`, `${pid} ${weight}${isRelease ? " release" : ""}${mem > 0 ? ` mem=${round(mem)} rss=0` : ""}`);
        await Deno.writeTextFile(`${dir}/pid`, String(pid));
        await Deno.writeTextFile(`${dir}/owner`, `${pid} ${new Date().toISOString()} ${what} (weight ${weight}${mem > 0 ? `, ${round(mem)} GB` : ""})\n`);
        return { n: 0, dir, door: 0, ports: {}, text: "" };
      }
      const busy: string[] = [];
      for (const n of asked ? [asked] : Array.from({ length: 160 }, (_, i) => i + 1)) {
        if (await alive(await holder(`slot-${n}`))) { busy.push(`${n} held by ${await holder(`slot-${n}`)}`); continue; }
        const { door, ports, moved, text } = layout(compose, n);
        const held = [];
        for (const p of new Set([...Object.values(ports), ...moved.values()])) if (await answers(p)) held.push(p);
        if (held.length) { busy.push(`${n}'s ports ${held.join(", ")} answer, its stack not down`); continue; }
        const dir = `${pool}/slot-${n}`;
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/weight`, `${pid} ${weight}${isRelease ? " release" : ""}`);
        await Deno.writeTextFile(`${dir}/pid`, String(pid));
        await Deno.writeTextFile(`${dir}/owner`, `${pid} ${new Date().toISOString()} ${app} ${what} (weight ${weight})\n`);
        return { n, dir, door, ports, text };
      }
      return why(`slot ${busy.join("; ")}`);
    });
    if (!("why" in got)) {
      const { n, dir, door, ports, text } = got;
      if (job) {
        say(`${what}: weight ${weight} of ${budget}${mem > 0 ? `, ${round(mem)} GB of ${round(memBudget())}` : ""}`);
        if (isRelease) yielding(1);
        let given = false;
        const release = () => {
          try { Deno.removeSync(dir, { recursive: true }); } catch { /* gone */ }
          if (isRelease && !given) { given = true; yielding(-1); }
        };
        const hold = (m: number, r: number) => {
          // Written aside and renamed: a claim reading it never sees it empty, a stack's weight.
          try {
            Deno.writeTextFileSync(`${dir}/weight.tmp`, `${pid} ${weight}${isRelease ? " release" : ""} mem=${round(m)} rss=${round(r)}`);
            Deno.renameSync(`${dir}/weight.tmp`, `${dir}/weight`);
          } catch { /* released */ }
        };
        return { n, dir, door, env: {}, release, queued, admitted: Date.now(), hold };
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
      say(`slot ${n}: ${url}, ports ${door}-${door + 99}, weight ${weight} of ${budget}, from ${copy}`);
      // mise reads the copy's .mise.toml, which it trusts as the checkout's.
      const trusted = [Deno.env.get("MISE_TRUSTED_CONFIG_PATHS"), copy].filter(Boolean).join(":");
      const env = { ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])), ORIGIN: url, APP_URL: url, STACK_SLOT: String(n), PRONTO_GATE_DIR: app, MISE_TRUSTED_CONFIG_PATHS: trusted };
      if (isRelease) yielding(1);
      let given = false;
      const release = () => {
        try { Deno.removeSync(`${dir}/pid`); } catch { /* gone */ }
        if (isRelease && !given) { given = true; yielding(-1); }
      };
      return { n, dir: copy, door, env, release, queued, admitted: Date.now() };
    }
    if (!wait) { say(`not taken: ${got.why}`); return undefined; }
    // Said again when the reason changes, not the memory the machine has available, which moves every look.
    const reason = got.why.replace(/[0-9.]+ GB available/, "");
    if (reason !== told) say(`waiting: ${got.why}`);
    told = reason;
    // Progress: a ticket ahead left, or the weight held dropped, below the least seen.
    if (got.release || got.ahead < fewest || got.used < lightest || got.memUsed < leanest) end = Date.now() + minutes * 60_000;
    fewest = Math.min(fewest, got.ahead);
    lightest = Math.min(lightest, got.used);
    leanest = Math.min(leanest, got.memUsed);
    if (Date.now() > end) throw new Error(`no slot, and the line did not move for ${minutes} minutes: ${got.why}`);
    // A memory job (an evaluation of tens of seconds) looks again sooner than a stack.
    await new Promise((r) => setTimeout(r, got.release ? 30_000 : weight === 0 ? 2000 : 5000));
  }
  } finally {
    await Deno.remove(`${queue}/${ticket}`).catch(() => {});
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

if (import.meta.main && ["--weight", "--what", "--mem", "--mem-learn"].includes(Deno.args[0] ?? "")) {
  // A job: its weight (and memory) claimed, no stack, the command run where it is.
  const split = Deno.args.indexOf("--");
  const opts = Deno.args.slice(0, split < 0 ? Deno.args.length : split);
  const cmd = split < 0 ? [] : Deno.args.slice(split + 1);
  const opt = (name: string) => opts[opts.indexOf(name) + 1];
  let mem = opts.includes("--mem") ? Number(opt("--mem")) : 0;
  const learn = opts.includes("--mem-learn") ? opt("--mem-learn") : undefined;
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
    const c = child = new Deno.Command(cmd[0], { args: cmd.slice(1), stdin: "inherit", stdout: "inherit", stderr: "inherit" }).spawn();
    // What it holds, at once and every second after, and its claim raised to it when it holds more;
    // a sample still out when it ends writes nothing.
    const s = slot;
    let running = true;
    const sample = async () => {
      const rss = await residentOf(c.pid);
      if (!running) return;
      peak = Math.max(peak, rss);
      if (rss > mem) mem = rss * 1.1;
      s.hold?.(mem, rss);
    };
    if (mem > 0) sample();
    const sampler = mem > 0 ? setInterval(sample, 1000) : undefined;
    status = await c.status;
    running = false;
    clearInterval(sampler);
    child = undefined;
    slot.release();
    slot = undefined;
    if (mem > 0 && attempt === 1 && status.signal === "SIGKILL" && killedFor(c.pid) === "pressure") {
      // Its claim was the peak it reached before it was killed, a quarter more: a floor.
      mem = Math.max(mem, peak * 1.25);
      say(`${what}: the memory watchdog killed it under the machine's pressure at ${round(peak)} GB; in line again for ${round(mem)} GB`);
      continue;
    }
    break;
  }
  // Its peak, for the next run's claim. A run that failed or was killed may have stopped before its
  // peak (a missing file, a bad flag): its peak only raises what was learned. One that ended before
  // a sample held next to nothing: learned as such, so it runs outside the pool.
  if (learn) {
    if (!(peak > 0)) peak = 0.05;
    const before = status.success ? 0 : Number((await Deno.readTextFile(learn).catch(() => "")).split(" ")[0]) || 0;
    await Deno.mkdir(learn.replace(/\/[^/]*$/, ""), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(learn, `${round(Math.max(peak, before))} ${what}\n`).catch(() => {});
  }
  Deno.exit(status.code);
}

if (import.meta.main) {
  if (!Deno.args.length) { console.error("usage: deno run -A tests/slot.ts launch [--watch] | <command...> | --weight <n> --what <label> -- <command...>"); Deno.exit(2); }
  const args = /(^|\/)saytw$/.test(Deno.args[0]) && Deno.args[1] === "launch@local" ? ["launch", ...Deno.args.slice(2)] : Deno.args;
  if (args !== Deno.args) {
    for (const verb of ["generate", "build"]) {
      say(`${verb}, in the checkout, as launch@local does before its stack`);
      const { code } = await new Deno.Command("./saytw", { args: [verb], cwd: app, stdin: "null", stdout: "inherit", stderr: "inherit" }).output();
      if (code) Deno.exit(code);
    }
  }
  const slot = await claim(Deno.pid, args.join(" "), Number(Deno.env.get("STACK_WEIGHT") ?? (args[0] === "launch" ? weights.launch : weights.stack)));
  let stopping: (() => Promise<void>) | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, async () => { await stopping?.(); slot.release(); Deno.exit(130); });
  }
  let code: number;
  if (args[0] === "launch") {
    const tmp = await Deno.makeTempDir({ prefix: "slot." });
    const s = stack(slot, tmp);
    const unwatch = args.includes("--watch") ? watch(slot, s.pc, s.env) : undefined;
    stopping = async () => { say("the stack going down"); unwatch?.(); await s.down(); };
    say(`the stack coming up at ${slot.env.APP_URL}, its log ${tmp}/process-compose.log; stop it with a signal to ${Deno.pid}`);
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
  Deno.exit(code);
}
