// daisyUI's published token contract, graded against the design layer
// (schema.cue's #Design and emit.cue); docs/design-tokens.md is its finding.
//
// The specification is data — daisyUI 5.7.32's 35 theme stylesheets, vendored
// verbatim under testdata/daisyui-5.7.32/ — and coverage of it is the check.
// Nothing here transcribes a published value: the suite parses the vendored
// CSS, so the quotation cannot drift from its source by being retyped. What
// the fixture holds is this platform's READING of that contract — which press
// role a token lands on, and why it departs — in columns of its own, so a
// departure cannot be hidden by rewording daisyUI.
//
// Every verdict is derived, and derived against the CONTRACT rather than
// against any app's emitted stylesheet, which is a generated artifact a hand
// edit could use to grant capabilities the platform does not publish:
//
//   - the role census is `cue export -e '#Design'` — the schema's own default
//     field set — with the emitted spelling of each role read out of emit.cue's
//     comprehensions, so neither is restated here;
//   - what the design layer refuses is measured by unifying a real `#Design`
//     with the name in question and reporting what cue does. The buckets are
//     open maps, so the answer is: it refuses nothing except an untwinned
//     colour. "pronto has no name for this" is therefore never asserted;
//   - whether a published value survives storage is measured by writing all 28
//     of a theme's values into a real `#Design` and comparing what exports
//     back, byte for byte. Values are opaque strings, so they all carry.
//
// That leaves the naming axis and the value axis genuinely independent, which
// is what makes the last case a progress meter rather than a constant: adding
// a role to the press preset moves the first and nothing else.
//
// The cue probes are why the suite runs under --allow-run=cue: a run of
// `cue export` is the only way to read the schema's own default field set
// without restating it, and a case nothing runs is a case that regresses
// silently. Runs under `sayt test` (.say.yaml's design-tokens rule).

// Local, so the oracle's permission set stays read + cue.
const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(msg);
};

const HERE = new URL("./", import.meta.url);
const VENDOR = new URL("testdata/daisyui-5.7.32/", HERE);
// The package, since the schema reads definitions its sibling files state; a
// probe is an expression over it, as cue merges no stdin file into a package.
const SCHEMA = ["."];
const EMITTER = new URL("emit.cue", HERE);
// A probe reads through stdin, not -e: Windows bounds a command line at
// 32K characters, which every theme's body at once overruns. It is a file of
// its own package importing pronto's, as a stdin file merges into none.
const probe = (expr: string) =>
  `package probe\n\nimport pronto "bonisoft.org/plugins/pronto"\n\n#Design: pronto.#Design\n#App: pronto.#App\n\nout: ${expr}\n`;

// The quotation this suite grades, hashed: every vendored theme stylesheet in
// themeOrder, then each reading's token and the daisyUI meaning it quotes. It
// lives here rather than in the fixture so that editing the fixture, or a
// vendored byte, cannot move the number it is checked against. Re-pin it only
// against a re-fetched tarball whose sha512 matches `source.integrity`.
const QUOTATION = "c4b08dc64c8c609118f2e9fb0b79b240b4cf857d6993c5b4312892f1b405037b";

type Reading = {
  token: string;
  published: string;
  bucket: string;
  maps_to: string;
  stance: "maps" | "declines" | "unnamed";
  why: string;
};
type Fixture = {
  source: Record<string, string>;
  reading: Reading[];
  pronto_only: { role: string; why: string }[];
};

const fixture: Fixture = JSON.parse(
  await Deno.readTextFile(new URL("testdata/daisyui-themes.json", HERE)),
);

const sha256 = async (text: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ------------------------------------------------------------------ the source

type Theme = { name: string; scheme: string; decls: { token: string; value: string }[]; text: string };

const themes = async (): Promise<Theme[]> => {
  const order = [...(await Deno.readTextFile(new URL("themeOrder.js", VENDOR)))
    .matchAll(/^\s*"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
  assert(order.length > 0, "themeOrder.js listed no theme, so nothing would be graded");
  return await Promise.all(order.map(async (name) => {
    const text = await Deno.readTextFile(new URL(`theme/${name}.css`, VENDOR));
    const scheme = /color-scheme:\s*([a-z]+);/.exec(text);
    assert(scheme !== null, `theme/${name}.css pins no color-scheme`);
    const decls = [...text.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)]
      .map((m) => ({ token: m[1], value: m[2].trim() }));
    return { name, scheme: scheme![1], decls, text };
  }));
};

// ------------------------------------------------------------------- the cue

const cue = async (args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> => {
  const p = new Deno.Command("cue", {
    args,
    cwd: HERE,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    // cue closes its input as soon as it decides the probe is bad, and a probe
    // large enough to fill the pipe then errors the writer. Its diagnosis is
    // on stderr either way, and that is what a caller wants to read.
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin)).catch(() => {});
    await w.close().catch(() => {});
  }
  const r = await p.output();
  const dec = new TextDecoder();
  return { ok: r.success, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
};

/** Unify `#Design` with one probe body and report what cue actually does. */
const design = (body: string) =>
  cue(["export", "-", "-e", "out", "--out", "json"], probe(`#Design & {\n${body}\n}\n`));

const q = (s: string) => JSON.stringify(s);
const kv = (o: Record<string, string>) =>
  Object.entries(o).map(([k, v]) => `${q(k)}: ${q(v)}`).join(", ");

// ------------------------------------------------------- the platform's contract

/** A role the design layer publishes: which bucket holds it, and its CSS name. */
type Role = { bucket: string; key: string; css: string; value: string };

type Contract = {
  /** bucket -> the prefix emit.cue puts in front of that bucket's keys. */
  prefix: Map<string, string>;
  /** "bucket/key" -> role. */
  roles: Map<string, Role>;
  /** The colour keys the closed twin mirrors. */
  twinned: string[];
  presets: string[];
};

const contract = async (): Promise<Contract> => {
  const emitter = await Deno.readTextFile(EMITTER);
  const prefix = new Map<string, string>();
  for (const m of emitter.matchAll(/for k, v in E\._design\.(\w+) \{"  --([a-z-]*)\\\(k\)/g)) {
    assert(!prefix.has(m[1]), `emit.cue spells the ${m[1]} bucket twice, so its CSS name is ambiguous`);
    prefix.set(m[1], m[2]);
  }

  const d = await cue(["export", ...SCHEMA, "-e", "#Design", "--out", "json"]);
  assert(d.ok, `cue could not export #Design, so there is no contract to grade:\n${d.out}`);
  const block = JSON.parse(d.out) as Record<string, Record<string, string> | string>;

  const roles = new Map<string, Role>();
  for (const [bucket, kvs] of Object.entries(block)) {
    // `dark` is the twin of `colors`, not a second set of roles; `preset` is
    // the choice, not a token.
    if (bucket === "dark" || bucket === "preset") continue;
    assert(typeof kvs === "object", `#Design.${bucket} is not a bucket of tokens`);
    if (bucket === "shell") {
      // Three fixed keys, emitted one literal line each rather than by
      // comprehension, so the emitter is asked about them by name.
      for (const key of Object.keys(kvs as Record<string, string>)) {
        assert(
          emitter.includes(`"  --shell-${key}: var(--\\(E._design.shell.${key}));"`),
          `#Design.shell.${key} is declared and emit.cue emits no --shell-${key}`,
        );
        roles.set(`shell/${key}`, {
          bucket,
          key,
          css: `--shell-${key}`,
          value: (kvs as Record<string, string>)[key],
        });
      }
      continue;
    }
    assert(prefix.has(bucket), `#Design.${bucket} is declared and emit.cue emits nothing from it`);
    for (const [key, value] of Object.entries(kvs as Record<string, string>)) {
      roles.set(`${bucket}/${key}`, { bucket, key, css: `--${prefix.get(bucket)}${key}`, value });
    }
  }

  const p = await cue(["export", ...SCHEMA, "-e", "#designPresets", "--out", "json"]);
  assert(p.ok, `cue could not export #designPresets:\n${p.out}`);
  return {
    prefix,
    roles,
    twinned: Object.keys(block.dark as Record<string, string>),
    presets: Object.keys(JSON.parse(p.out) as Record<string, unknown>),
  };
};

// ----------------------------------------------------------------- the probes

/** Which #Design bucket a name for `token` would live in, and under what key. */
const home = (r: Reading) => ({
  bucket: r.bucket,
  key: r.token.replace(/^--/, "").replace(/^color-/, "").replace(/^radius-/, ""),
});

/**
 * What cue does when the design layer is asked to carry a name it does not
 * publish. Run per bucket, twinned and not, so "refused" is a measurement.
 */
type Admission = { bucket: string; bare: boolean; twinned: boolean; bareErr: string };

const admissions = async (buckets: string[]): Promise<Admission[]> =>
  await Promise.all(buckets.map(async (bucket) => {
    // The component bucket holds references rather than values, so its probe is
    // one: what is measured is whether a NEW NAME is admitted.
    const key = kv({ "oracle-probe": bucket === "component" ? "var(--sp-md)" : "1px" });
    const bare = await design(`\t${bucket}: {${key}}`);
    // `dark` is closed against `colors`, so supplying a twin is only a
    // meaningful probe there — in any other bucket it is the refusal.
    const twin = bucket === "colors"
      ? await design(`\tcolors: {${key}}\n\tdark: {${key}}`)
      : bare;
    return { bucket, bare: bare.ok, twinned: twin.ok, bareErr: bare.out.trim() };
  }));

/**
 * Every published value of every theme, written into a real `#Design` under a
 * name derived from the daisyUI token, and read back. This measures storage
 * with naming held out of it: the keys are invented for the probe, so what it
 * reports is whether the VALUE survives, whatever the role ends up being called.
 */
type Carried = { theme: string; token: string; want: string; got: string | null };

const carriage = async (
  ts: Theme[],
  reading: Reading[],
  driven: Set<string>,
): Promise<{ ok: boolean; out: string; rows: Carried[] }> => {
  const asked: { theme: string; body: string; want: Record<string, Record<string, string>> }[] = [];
  for (const t of ts) {
    const want: Record<string, Record<string, string>> = {};
    const byToken = new Map(t.decls.map((d) => [d.token, d.value]));
    for (const r of reading) {
      const value = byToken.get(r.token);
      if (value === undefined) continue;
      driven.add(`${t.name}/${r.token}`);
      const { bucket, key } = home(r);
      (want[bucket] ??= {})[key] = value;
    }
    const lines = Object.entries(want).map(([b, o]) => `\t\t${b}: {${kv(o)}}`);
    // The closed twin: a colour with no dark half is not a value cue will
    // export at all, so the probe supplies the light half twice. That it must
    // is one of the departures this suite records, not a workaround for one.
    if (want.colors) lines.push(`\t\tdark: {${kv(want.colors)}}`);
    asked.push({ theme: t.name, body: `\t${q(t.name)}: #Design & {\n${lines.join("\n")}\n\t}`, want });
  }
  const r = await cue(
    ["export", "-", "-e", "out", "--out", "json"], probe(`{\n${asked.map((a) => a.body).join("\n")}\n}\n`),
  );
  if (!r.ok) return { ok: false, out: r.out, rows: [] };
  const out = JSON.parse(r.out) as Record<string, Record<string, Record<string, string>>>;
  const rows: Carried[] = [];
  for (const a of asked) {
    for (const [bucket, o] of Object.entries(a.want)) {
      for (const [key, want] of Object.entries(o)) {
        rows.push({ theme: a.theme, token: `${bucket}/${key}`, want, got: out[a.theme][bucket][key] ?? null });
      }
    }
  }
  return { ok: true, out: r.out, rows };
};

// ---------------------------------------------------------------- colour math

/** Oklab of a published `oklch(L% C H)`, or null if the value is not one. */
const oklab = (v: string): [number, number, number] | null => {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v.trim());
  if (!m) return null;
  const [L, C, H] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  return [L, C * Math.cos(H), C * Math.sin(H)];
};

/** Oklab -> cone response, the shared first half of both transforms below. */
const lms = ([L, a, b]: [number, number, number]) => [
  (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
  (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
  (L - 0.0894841775 * a - 1.291485548 * b) ** 3,
];

const linearSrgb = (lab: [number, number, number]) => {
  const [l, m, s] = lms(lab);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const linearP3 = (lab: [number, number, number]) => {
  const [l, m, s] = lms(lab);
  const X = 1.2268798758 * l - 0.5578149944 * m + 0.2813910456 * s;
  const Y = -0.0405757452 * l + 1.1122868032 * m - 0.071711058 * s;
  const Z = -0.0763729366 * l - 0.4214933324 * m + 1.5869240244 * s;
  return [
    2.4934969119 * X - 0.9313836179 * Y - 0.4027107845 * Z,
    -0.8294889696 * X + 1.7626640603 * Y + 0.0236246858 * Z,
    0.0358458302 * X - 0.0761723893 * Y + 0.956884524 * Z,
  ];
};

// A channel this far outside [0,1] is rounding, not a colour outside the space.
const GAMUT_TOL = 0.002;
const inGamut = (rgb: number[]) => rgb.every((c) => c >= -GAMUT_TOL && c <= 1 + GAMUT_TOL);

// -------------------------------------------------------------- one shared run

type Report = Awaited<ReturnType<typeof build>>;

const build = async () => {
  const ts = await themes();
  const c = await contract();
  const driven = new Set<string>();
  const carried = await carriage(ts, fixture.reading, driven);
  const adm = await admissions([...c.prefix.keys()]);
  return { themes: ts, contract: c, driven, carried, admissions: adm };
};

let pending: Promise<Report> | null = null;
const report = () => (pending ??= build());

// --------------------------------------------------------------------- cases

Deno.test("the specification the suite grades is the one that was pinned", async () => {
  const ts = await themes();
  // Length-prefixed, so no rewording can be absorbed by a delimiter that
  // happens to appear inside the text it separates.
  const run = (s: string) => `${s.length}:${s}`;
  const parts = [
    ...ts.map((t) => run(t.name) + run(t.text)),
    ...fixture.reading.map((r) => run(r.token) + run(r.published)),
  ];
  const got = await sha256(parts.join(""));
  assert(
    got === QUOTATION,
    `the quotation hashes ${got}, pinned ${QUOTATION}.\n` +
      `Either a vendored theme stylesheet changed, or a reading reworded what daisyUI publishes. ` +
      `Both are departures this suite exists to make visible: re-pin only against a re-fetched ` +
      `${fixture.source.tarball} whose sha512 is ${fixture.source.integrity}.`,
  );
});

Deno.test("the vendored themes and the platform's reading join, and every published declaration is graded", async () => {
  const { themes: ts, driven } = await report();
  const problems: string[] = [];

  // daisyUI's contract is that every theme declares the same roster. The
  // reading is written against that roster, so it is a premise, not a detail.
  const roster = ts[0].decls.map((d) => d.token).join(" ");
  for (const t of ts) {
    const mine = t.decls.map((d) => d.token).join(" ");
    if (mine !== roster) problems.push(`${t.name} declares ${mine}, where ${ts[0].name} declares ${roster}`);
  }

  const read = new Set(fixture.reading.map((r) => r.token));
  for (const token of ts[0].decls.map((d) => d.token)) {
    if (!read.has(token)) problems.push(`${token} is published and this platform has no reading of it`);
  }
  for (const r of fixture.reading) {
    if (!ts[0].decls.some((d) => d.token === r.token)) {
      problems.push(`${r.token} is read and no vendored theme declares it`);
    }
  }

  // The coverage property, and the reason the grading pass fills `driven`
  // rather than an enumeration of the same rows: a published declaration that
  // no case reached would otherwise be graded by silence.
  const undriven = ts.flatMap((t) =>
    t.decls.filter((d) => !driven.has(`${t.name}/${d.token}`)).map((d) => `${t.name}/${d.token}`)
  );
  if (undriven.length > 0) {
    problems.push(
      `${undriven.length} published declarations nothing graded: ${undriven.slice(0, 6).join(", ")}` +
        (undriven.length > 6 ? ` and ${undriven.length - 6} more` : ""),
    );
  }
  assert(problems.length === 0, `\n  ${problems.join("\n  ")}`);
});

Deno.test("every role the reading names is one the design layer publishes, and no two readings claim the same one", async () => {
  const { contract: c } = await report();
  const problems: string[] = [];
  const claimed = new Map<string, string>();
  for (const r of fixture.reading) {
    if (!["maps", "declines", "unnamed"].includes(r.stance)) {
      problems.push(`${r.token}: stance ${q(r.stance)} is not one of maps | declines | unnamed`);
    }
    if (r.why === "") problems.push(`${r.token}: read with no why`);
    if (r.stance === "maps" && r.maps_to === "") problems.push(`${r.token}: stance maps and maps to nothing`);
    if (r.stance !== "maps" && r.maps_to !== "") {
      problems.push(`${r.token}: stance ${r.stance} and maps to ${r.maps_to}`);
    }
    if (!c.prefix.has(r.bucket) && r.bucket !== "shell") {
      problems.push(`${r.token}: would live in ${q(r.bucket)}, which #Design does not declare`);
    }
    if (r.maps_to === "") continue;
    const role = c.roles.get(r.maps_to);
    if (role === undefined) {
      problems.push(`${r.token}: maps to ${r.maps_to}, which #Design does not publish`);
      continue;
    }
    if (role.bucket !== r.bucket) {
      problems.push(`${r.token}: would live in ${r.bucket} and maps into ${role.bucket}`);
    }
    // Many-to-one is what information loss IS for a token contract: two
    // published tokens sharing one role leaves the theme no way to say which
    // was which, however cleanly each half reads on its own.
    const first = claimed.get(r.maps_to);
    if (first !== undefined) {
      problems.push(`${r.maps_to} is claimed by both ${first} and ${r.token}, which collapses two published tokens into one`);
    } else claimed.set(r.maps_to, r.token);
  }
  assert(problems.length === 0, `\n  ${problems.join("\n  ")}`);
});

Deno.test("every role the design layer publishes is mapped or stated as pronto's own", async () => {
  const { contract: c } = await report();
  const mapped = new Set(fixture.reading.map((r) => r.maps_to).filter(Boolean));
  const stated = new Map(fixture.pronto_only.map((p) => [p.role, p.why]));
  const problems: string[] = [];
  for (const [name, role] of c.roles) {
    if (mapped.has(name)) continue;
    if (!stated.has(name)) problems.push(`${role.css} (${name}) is published, mapped to no daisyUI token, and unstated`);
    else if (stated.get(name) === "") problems.push(`${role.css} is stated as pronto's own with no reason`);
  }
  for (const name of stated.keys()) {
    if (!c.roles.has(name)) problems.push(`${name} is stated as pronto's own and #Design does not publish it`);
    if (mapped.has(name)) problems.push(`${name} is both mapped and stated as pronto's own`);
  }
  assert(problems.length === 0, `\n  ${problems.join("\n  ")}`);
});

Deno.test("what the design layer refuses is measured, and it refuses only an untwinned colour", async () => {
  const { admissions: adm } = await report();
  const problems: string[] = [];
  for (const a of adm) {
    // Every bucket admits any name — `component` constrains its values to
    // references, never its names — so a name is never the thing refused. This is asserted so that closing a bucket — which is the one
    // change that would make "pronto has no name for it" true — fails here and
    // is read as a finding rather than passing as an opinion.
    if (!a.twinned) problems.push(`#Design.${a.bucket} refused a new key even with a twin, so a name really is impossible there`);
    const wantsTwin = a.bucket === "colors";
    if (a.bare !== !wantsTwin) {
      problems.push(
        wantsTwin
          ? `#Design.colors took a new colour with no dark half; the twin is not closed`
          : `#Design.${a.bucket} refused a new key: ${a.bareErr}`,
      );
    }
  }
  const colors = adm.find((a) => a.bucket === "colors");
  assert(colors !== undefined, "no colors bucket was probed, so the twin was never measured");
  if (colors !== undefined && !/dark\."?oracle-probe"?: incomplete value/.test(colors.bareErr)) {
    problems.push(`the untwinned colour failed for some reason other than the missing twin: ${colors.bareErr}`);
  }
  assert(problems.length === 0, `\n  ${problems.join("\n  ")}`);
});

Deno.test("every published value is carried into the design layer byte for byte", async () => {
  const { carried } = await report();
  assert(carried.ok, `cue refused the published values outright:\n${carried.out}`);
  const lost = carried.rows.filter((r) => r.got !== r.want);
  assert(
    lost.length === 0,
    `${lost.length} of ${carried.rows.length} published values did not survive storage:\n  ` +
      lost.slice(0, 10).map((r) => `${r.theme}/${r.token}: wrote ${q(r.want)}, read ${q(r.got ?? "")}`).join("\n  "),
  );
});

Deno.test("the wide-gamut census is a fact about daisyUI's palette and not a loss here", async () => {
  // A colour bucket holds an opaque string that the emitter interpolates into
  // light-dark() unchanged — press's own inks are hsl() — so an oklch outside
  // sRGB is stored exactly and this census costs the mapping nothing. It is
  // pinned because it is the number design-tokens.md quotes, and because it is
  // the fact that would matter the day the design layer grew a colour type.
  const { themes: ts, carried } = await report();
  const rows = ts.flatMap((t) => t.decls.map((d) => ({ theme: t.name, ...d })));
  const beyond = (space: (lab: [number, number, number]) => number[]) =>
    rows.filter((r) => {
      const lab = oklab(r.value);
      return lab !== null && !inGamut(space(lab));
    });
  const colours = rows.filter((r) => oklab(r.value) !== null);
  const srgb = beyond(linearSrgb), p3 = beyond(linearP3);
  const themeCount = (rs: { theme: string }[]) => new Set(rs.map((r) => r.theme)).size;
  assert(colours.length === 700, `${colours.length} colour declarations, not the 700 published`);
  assert(
    srgb.length === 128 && themeCount(srgb) === 26,
    `${srgb.length} declarations in ${themeCount(srgb)} themes fall outside sRGB, not 128 in 26`,
  );
  assert(
    p3.length === 12 && themeCount(p3) === 6,
    `${p3.length} declarations in ${themeCount(p3)} themes fall outside Display-P3, not 12 in 6`,
  );
  // The point of the census, stated as an assertion so it cannot rot into a
  // claim: not one of those values is a value the design layer loses.
  const lost = new Set(carried.rows.filter((r) => r.got !== r.want).map((r) => `${r.theme}/${r.token}`));
  assert(lost.size === 0, `${lost.size} values are lost, so this census stops being an observation and becomes a verdict`);
});

Deno.test("a colour the preset does not publish costs a twin, and one it does publish is rebound silently", async () => {
  const { contract: c } = await report();
  const orphans = fixture.reading
    .filter((r) => r.maps_to === "" && r.bucket === "colors")
    .map((r) => home(r).key);
  const fresh = orphans.filter((n) => !c.roles.has(`colors/${n}`));
  const collides = orphans.filter((n) => c.roles.has(`colors/${n}`));
  assert(fresh.length > 0 && collides.length > 0, `${fresh.length} fresh and ${collides.length} colliding orphans`);

  // A name the preset does not publish: close() over D.colors makes
  // dark.<name> non-concrete, and cue refuses to write the file at all. The
  // name itself is admitted — case "what the design layer refuses" measures
  // that — so what an app pays for a new colour is exactly one dark value.
  const bad = await cue(
    ["export", "-", "-e", "out", "--out", "json"], probe(`{\n${fresh.map((n) => `${q(n)}: #Design & {colors: {${q(n)}: "#123456"}}`).join("\n")}\n}\n`),
  );
  assert(!bad.ok, `cue accepted ${fresh.length} untwinned colours:\n${bad.out}`);
  const flat = bad.out.replaceAll('"', "");
  const quiet = fresh.filter((n) => !flat.includes(`${n}.dark.${n}`));
  assert(quiet.length === 0, `close() demanded no twin for: ${quiet.join(", ")}\n${bad.out}`);

  // A name the preset HAS, meaning something else: nothing objects. The value
  // is simply written into press's role, which is why `maps_to` may not be
  // derived from a shared word and why this suite grades injectivity.
  const ok = await cue(
    ["export", "-", "-e", "out", "--out", "json"], probe(`{\n${
      collides.map((n) => `${q(n)}: #Design & {colors: {${q(n)}: "#123456"}, dark: {${q(n)}: "#123456"}}`).join("\n")
    }\n}\n`),
  );
  assert(ok.ok, `cue refused a colliding name:\n${ok.out}`);
  const out = JSON.parse(ok.out) as Record<string, { colors: Record<string, string> }>;
  const kept = collides.filter((n) => out[n].colors[n] !== "#123456");
  assert(kept.length === 0, `these kept press's value instead of taking daisyUI's: ${kept.join(", ")}`);
});

Deno.test("one preset, two appearances, no siblings: daisyUI's theme system has no seam here", async () => {
  const { contract: c } = await report();
  const problems: string[] = [];

  // daisyUI ships 35 identities and selects among them at runtime with
  // [data-theme]. Each of these probes asks the schema for the seam that would
  // hold a second identity, and reports what cue says instead of arguing it.
  if (c.presets.length !== 1) {
    problems.push(`#designPresets publishes ${c.presets.length} identities (${c.presets.join(", ")}), so this case's premise moved`);
  }
  const unknown = await design(`\tpreset: "dracula"`);
  if (unknown.ok) problems.push(`an app may name a preset the schema does not publish`);
  else if (!/undefined field: dracula/.test(unknown.out)) {
    problems.push(`naming an unpublished preset failed for another reason: ${unknown.out.trim()}`);
  }

  // A third appearance. `dark` is the twin and the schema is a closed
  // definition, so there is no room for a second sibling palette beside it.
  const third = await design(`\tdim: {${kv({ primary: "#000000" })}}`);
  if (third.ok) problems.push(`#Design took a third appearance bucket, so a twin is not the limit`);
  else if (!/dim: field not allowed/.test(third.out)) {
    problems.push(`a third appearance failed for another reason: ${third.out.trim()}`);
  }
  const twinKeys = new Set(c.twinned);
  const colourKeys = [...c.roles.values()].filter((r) => r.bucket === "colors").map((r) => r.key);
  const untwinned = colourKeys.filter((k) => !twinKeys.has(k));
  if (untwinned.length > 0 || twinKeys.size !== colourKeys.length) {
    problems.push(`the twin mirrors ${twinKeys.size} of ${colourKeys.length} colours, so appearance is not exactly two`);
  }

  // Two identities side by side under one app, which is what [data-theme]
  // selects between. #App.surface.design is one struct.
  const siblings = await cue(
    ["export", "-", "-e", "out", "--out", "json"], probe(`#App.surface & {design: {press: #Design, dracula: #Design}}\n`),
  );
  if (siblings.ok) problems.push(`#App.surface.design held two identities, so sibling themes are expressible`);
  else if (!/design\.dracula: field not allowed/.test(siblings.out)) {
    problems.push(`two sibling identities failed for another reason: ${siblings.out.trim()}`);
  }
  assert(problems.length === 0, `\n  ${problems.join("\n  ")}`);
});

// The naming meter, pinned as an EQUALITY the way meta.design.pendingLiterals
// is: the preset publishing a role for one more daisyUI token moves the
// reading, and the pin moves with it in a diff a reviewer sees. Pinned as the
// mapping itself and not its count, so a swap that names one token and drops
// another cannot hold the number. A ceiling would let the reading fall in
// silence; an unpinned red would keep this file out of the gate, where its
// other nine cases regress unseen. The full report below is the deliverable,
// printed whenever the reading and the pin disagree. Kept sorted, as the
// reading is.
const PINNED_NAMED = [
  "--color-base-100->colors/neutral",
  "--color-base-200->colors/surface",
  "--color-base-300->colors/surface-muted",
  "--color-base-content->colors/primary",
  "--color-error->colors/danger",
  "--color-primary->colors/accent",
  "--radius-box->rounded/md",
  "--radius-field->rounded/sm",
  "--size-field->control/h",
];

Deno.test("the expressibility meter reads its pinned mapping: which of the 28 tokens land on a published role", async () => {
  const { themes: ts, contract: c, carried } = await report();
  const named = fixture.reading.filter((r) => r.maps_to !== "" && c.roles.has(r.maps_to));
  const unnamed = fixture.reading.filter((r) => !named.includes(r));
  const total = fixture.reading.length;

  const lostIn = (theme: string) =>
    carried.rows.filter((r) => r.theme === theme && r.got !== r.want).length;

  const lines: string[] = [];
  for (const t of ts) {
    const carries = t.decls.length - lostIn(t.name);
    if (named.length === total && carries === t.decls.length) continue;
    const value = (token: string) => t.decls.find((d) => d.token === token)?.value ?? "";
    const rem = (token: string) => parseFloat(value(token));
    // What this theme sets for itself, so its loss is something on a page
    // rather than a name in a table.
    const shown = [
      ...(value("--border") !== "1px" ? [`--border: ${value("--border")}`] : []),
      ...(value("--depth") !== "0" ? [`--depth: ${value("--depth")}`] : []),
      ...(value("--noise") !== "0" ? [`--noise: ${value("--noise")}`] : []),
      ...(rem("--radius-field") > rem("--radius-box")
        ? [`field ${value("--radius-field")} > box ${value("--radius-box")}`]
        : []),
      ...(rem("--radius-selector") > rem("--radius-box")
        ? [`selector ${value("--radius-selector")} > box ${value("--radius-box")}`]
        : []),
    ];
    lines.push(
      `${t.name} (${t.scheme}): ${named.length}/${total} named, ${carries}/${t.decls.length} carried` +
        `; ${shown.join("; ") || "nothing beyond the shared loss"}`,
    );
  }

  const twin = unnamed.filter((r) => r.bucket === "colors");
  const free = unnamed.filter((r) => r.bucket !== "colors");
  const reading = named.map((r) => `${r.token}->${r.maps_to}`).sort();
  assert(
    JSON.stringify(reading) === JSON.stringify(PINNED_NAMED),
    `the meter reads ${named.length} of ${total} named and the pin holds ${PINNED_NAMED.length}. ` +
      `Move PINNED_NAMED with the preset, never the other way.\n\n` +
      `${lines.length} of ${ts.length} published themes cannot be expressed, on the naming axis alone.\n\n` +
      `NAMES: the design layer publishes ${c.roles.size} roles. ${named.length} of the ${total} ` +
      `published tokens land on one ` +
      `(${reading.join(" ")}), and the remaining ` +
      `${c.roles.size - named.length} ROLES are reached by no daisyUI token and are stated as pronto's own.\n` +
      `The other ${unnamed.length} are not refused by #Design — every bucket is an open map, and the ` +
      `probes in this file measure that — they are simply unpublished, so each app would coin its own ` +
      `spelling and nothing shared could bind to it.\n` +
      `  ${twin.length} would go in colors, where the closed twin makes each cost a dark value too: ` +
      `${twin.map((r) => r.token).join(" ")}\n` +
      `  ${free.length} would go in an untwinned bucket and cost one line each: ` +
      `${free.map((r) => `${r.token} (${r.bucket})`).join(" ")}\n\n` +
      `VALUES: ${carried.rows.length} of ${carried.rows.length} published declarations are stored byte ` +
      `for byte, wide-gamut oklch included — a bucket holds an opaque string. Storage is not the gap.\n\n` +
      `A theme is also one identity pinning its own color-scheme, where #Design is one preset with a ` +
      `closed twin, so each of these would additionally have to write its light half into dark.\n` +
      `What each theme sets for itself:\n  ` + lines.join("\n  "),
  );
});
