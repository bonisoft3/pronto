#!/usr/bin/env -S deno run --allow-read=.
// The outer loop's checkable budget, levied on the loop itself.
//
// `docs/2026-08-27-what-must-be-reviewed.md` splits every obligation in two:
// checkable is mechanical and total, reviewable is expensive and levied by
// consequence. The turn command and its workflow scripts are prose an agent
// reads, so nothing downstream would notice a verb that does not exist, an
// agentType naming no card, or a phase title the progress tree never groups
// under. Those are all checkable, so none of them are reviewed.

/**
 * The lifecycle verbs, plus the CLI's own `help`. A project may declare custom
 * verbs in `.say.yaml`, so this catches the invented ones a command doc is
 * likely to reach for — `publish`, `vet`, `preview` — not every name sayt can
 * ever dispatch.
 */
const VERBS = new Set([
  "setup",
  "doctor",
  "generate",
  "lint",
  "build",
  "test",
  "launch",
  "integrate",
  "release",
  "verify",
  "help",
]);

/**
 * What a command's prose commits it to, and the tool that makes it possible. A
 * grant naming a tool under a pattern — `Bash(sayt:*)` — does not satisfy a
 * command that drives a toolchain, which is how a turn dies at its first `git`.
 */
const NEEDS: [(text: string) => boolean, string][] = [
  [(t) => saytVerbs(t).length > 0 || /`(?:git|docker|deno|gh|just|mise|npm|pnpm|bun)\s/.test(t) ||
    /```(?:sh|bash|shell|console)\n/.test(t), "Bash"],
  [(t) => /`[^`\n]+` skill\b/.test(t), "Skill"],
  [(t) => /\bdesign\b`?[^.\n]{0,20}\bskill\b/i.test(t), "Artifact"],
  [(t) => /\bWorkflow tool\b/.test(t), "Workflow"],
  [(t) => /\bAgent tool\b/.test(t) || /dispatch the `[^`]+` agent/.test(t), "Agent"],
];

/** The inner loop's surfaces. A turn that codes without naming these is not driving sayt. */
const INNER_LOOP = ["sayt:tdd", "sayt:sayt-dev-loop"];

/** Globals a workflow script may not touch: they throw at runtime because they would break resume. */
const FORBIDDEN_IN_WORKFLOW = [
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
  /\bnew\s+Date\s*\(\s*\)/,
];

type Failure = { where: string; want: string; got: string };

function read(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

function list(dir: string, ext: string): string[] {
  try {
    return [...Deno.readDirSync(dir)]
      .filter((e) => e.isFile && e.name.endsWith(ext))
      .map((e) => `${dir}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The `meta` literal a workflow opens with. Its own contract makes it a pure
 * literal, so no brace inside it is quoted and counting them is decidable.
 */
function metaBlock(body: string): string {
  const start = body.indexOf("export const meta");
  const open = start < 0 ? -1 : body.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return body.slice(open, i + 1);
  }
  return "";
}

/** Where a command states what it does, as opposed to what it declares. */
function afterFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const end = body.indexOf("\n---", 4);
  return end < 0 ? body : body.slice(end + 4);
}

/** Frontmatter keys of a `---`-delimited markdown header, in order. */
function frontmatter(body: string): Map<string, string> {
  const keys = new Map<string, string>();
  if (!body.startsWith("---\n")) return keys;
  const end = body.indexOf("\n---", 4);
  if (end < 0) return keys;
  for (const line of body.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z-]+):\s*(.*)$/);
    if (m) keys.set(m[1], m[2].trim());
  }
  return keys;
}

/**
 * The agent types this plugin declares, by the `name:` its card carries — the
 * manifest's `agents` paths are what the registry reads, so a card outside them
 * is not an agent however well it is written.
 */
function agentNames(fails: Failure[]): Set<string> {
  let manifest: { agents?: unknown };
  try {
    manifest = JSON.parse(read(".claude-plugin/plugin.json") ?? "{}");
  } catch (e) {
    fails.push({
      where: ".claude-plugin/plugin.json",
      want: "parseable JSON",
      got: e instanceof Error ? e.message : String(e),
    });
    return new Set();
  }
  const declared = manifest.agents ?? ["./agents"];
  const dirs: string[] = Array.isArray(declared) ? declared : [declared];
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const path of list(dir.replace(/^\.\//, ""), ".md")) {
      const name = frontmatter(read(path)!).get("name");
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Every verb a command tells an agent to run. Only code counts — an inline span
 * or a fenced block — because a command is prose that mentions sayt constantly
 * and "sayt has ten verbs" is a sentence, not an invocation. Flags before the
 * verb are skipped: `sayt -d apps/x integrate` runs integrate.
 */
function saytVerbs(body: string): string[] {
  const code = [
    ...[...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    ...[...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]),
  ].join("\n");
  return [...code.matchAll(/\bsayt\s+(?:-{1,2}[a-z][a-z-]*(?:[= ]\S+)?\s+)*([a-z][a-z-]*)/g)]
    .map((m) => m[1]);
}

export function checkCommands(fails: Failure[]): number {
  const commands = list("commands", ".md");
  if (commands.length === 0) {
    fails.push({ where: "commands/", want: "at least one command", got: "no directory" });
    return 0;
  }
  for (const path of commands) {
    const body = read(path)!;
    const fm = frontmatter(body);
    for (const key of ["description", "argument-hint"]) {
      if (!fm.has(key)) fails.push({ where: path, want: `frontmatter ${key}`, got: "absent" });
    }
    // A `!`cmd`` span runs at expansion time and needs the Bash grant named in
    // frontmatter; without it the command fails before its own preflight can
    // report which tier is missing.
    if (/!`[^`\n]+`/.test(body) && !fm.has("allowed-tools")) {
      fails.push({ where: path, want: "allowed-tools for its !`` spans", got: "absent" });
    }
    // An absent grant inherits everything; a present one has to carry what the
    // steps below it reach for, and only a bare name grants a tool outright.
    if (fm.has("allowed-tools")) {
      const granted = new Set(
        fm.get("allowed-tools")!.split(",").map((t) => t.trim()).filter((t) => !t.includes("(")),
      );
      // The grant line names tools itself, so a trigger read over the whole
      // file would match a command's own frontmatter and demand what it just
      // declared under a pattern.
      const prose = afterFrontmatter(body);
      for (const [triggers, tool] of NEEDS) {
        if (triggers(prose) && !granted.has(tool)) {
          fails.push({ where: path, want: `allowed-tools grants ${tool}`, got: fm.get("allowed-tools")! });
        }
      }
    }
    for (const verb of saytVerbs(body)) {
      if (!VERBS.has(verb)) {
        fails.push({ where: path, want: "a real sayt verb", got: `sayt ${verb}` });
      }
    }
  }

  const turn = read("commands/turn.md");
  if (turn === null) {
    fails.push({ where: "commands/turn.md", want: "the turn command", got: "absent" });
  } else {
    for (const surface of INNER_LOOP) {
      if (!turn.includes(surface)) {
        fails.push({ where: "commands/turn.md", want: `names ${surface}`, got: "absent" });
      }
    }
  }
  return commands.length;
}

/** Every workflow script a command points at, as a repo-relative path. */
function commandWorkflowRefs(): string[] {
  const refs = new Set<string>();
  for (const path of list("commands", ".md")) {
    for (const [, ref] of read(path)!.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.js)/g)) {
      refs.add(ref);
    }
  }
  return [...refs];
}

export function checkWorkflows(fails: Failure[]): number {
  const scripts = list("workflows", ".js");
  const seats = agentNames(fails);
  // Commands name workflow scripts by path, so an absent directory is a broken
  // reference, not an empty one — and `list` cannot tell them apart.
  for (const path of commandWorkflowRefs()) {
    if (read(path) === null) {
      fails.push({ where: path, want: "a workflow script a command names", got: "absent" });
    }
  }
  for (const path of scripts) {
    const body = read(path)!;

    if (!body.trimStart().startsWith("export const meta")) {
      fails.push({ where: path, want: "opens with export const meta", got: body.slice(0, 24) });
    }

    for (const pattern of FORBIDDEN_IN_WORKFLOW) {
      const hit = body.match(pattern);
      if (hit) fails.push({ where: path, want: "no wall-clock or randomness", got: hit[0] });
    }

    // Progress groups are matched by exact title, so a title with no meta entry
    // renders its own ungrouped box rather than erroring. Both spellings count:
    // a bare phase() call, and the `phase:` option every agent inside a
    // pipeline() or parallel() stage carries instead.
    const declared = new Set(
      [...metaBlock(body).matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]),
    );
    const used = [
      ...[...body.matchAll(/\bphase\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...body.matchAll(/\bphase:\s*'([^']+)'/g)].map((m) => m[1]),
    ];
    for (const title of used) {
      if (!declared.has(title)) {
        fails.push({ where: path, want: `meta.phases entry for '${title}'`, got: "absent" });
      }
    }

    // A seat resolves by its card's frontmatter name, not by its filename, and
    // naming one that does not exist fails at dispatch — deep inside a fan-out,
    // after the expensive stages have already run. A literal agentType is read
    // straight off the call; an interpolated one is unreadable statically, so a
    // script that builds them declares its seats in `const SEATS` and that list
    // is what gets checked.
    const named = [...body.matchAll(/agentType:\s*'pronto:([^']+)'/g)].map((m) => m[1]);
    const interpolates = /agentType:\s*`pronto:\$\{/.test(body);
    const seatList = body.match(/\bconst SEATS\s*=\s*\[([^\]]*)\]/);
    if (interpolates && seatList === null) {
      fails.push({
        where: path,
        want: "const SEATS listing the interpolated agentTypes",
        got: "absent",
      });
    }
    const fromList = seatList
      ? [...seatList[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      : [];
    for (const type of [...named, ...(interpolates ? fromList : [])]) {
      if (!seats.has(type)) {
        fails.push({
          where: path,
          want: `a card whose name is ${type}`,
          got: `pronto declares ${[...seats].sort().join(", ")}`,
        });
      }
    }
  }
  return scripts.length;
}

function selfTest(): void {
  const fails: Failure[] = [];
  const commands = checkCommands(fails);
  const workflows = checkWorkflows(fails);

  for (const f of fails) {
    console.error(`FAIL ${f.where}: want ${f.want}, got ${f.got}`);
  }
  if (fails.length > 0) Deno.exit(1);
  console.error(
    `loop self-test: ${commands} command(s) and ${workflows} workflow script(s) — ` +
      "verbs, inner-loop surfaces, phase titles and seat references all resolve",
  );
}

if (import.meta.main) {
  if (Deno.args[0] !== "--self-test") {
    console.error("usage: check-loop.ts --self-test");
    Deno.exit(2);
  }
  selfTest();
}
