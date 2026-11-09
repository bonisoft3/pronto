import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const writer = join(repo, "plugins/pronto/write.ts");

Deno.test("a settled build preserves outputs and still follows new template reads", async () => {
  const app = await Deno.makeTempDir({
    dir: join(repo, "apps"),
    prefix: ".write-test-",
  });
  const decoder = new TextDecoder();
  async function build(success = true): Promise<string> {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--config",
        join(repo, "plugins/pronto/deno.json"),
        "--allow-read",
        "--allow-write=.",
        "--allow-run",
        "--allow-env",
        writer,
        ".",
      ],
      cwd: app,
      env: { ...Deno.env.toObject(), MISE_TRUSTED_CONFIG_PATHS: repo },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = decoder.decode(result.stderr);
    assertEquals(result.success, success, text);
    return text;
  }
  async function outputs(): Promise<Record<string, string>> {
    const { written } = JSON.parse(
      await Deno.readTextFile(join(app, ".pronto/manifest.json")),
    );
    const result: Record<string, string> = {};
    for (
      const path of [
        ...written,
        "program_derived.cue",
        "program_cel.cue",
        ".pronto/facts.json",
      ]
    ) {
      result[path] = await Deno.readTextFile(join(app, path));
    }
    return result;
  }
  try {
    await copyJsfb(app);
    await build();
    async function gate(success = true): Promise<string> {
      const result = await new Deno.Command("mise", {
        args: [
          "tool-stub",
          join(repo, "plugins/sayt/nu.toml"),
          join(repo, "plugins/sayt/sayt.nu"),
          // Piped and outside CI, sayt folds each command's output into a log
          // it names; the assertions read what write.ts itself printed.
          "--verbose",
          "build",
        ],
        cwd: app,
        env: { MISE_TRUSTED_CONFIG_PATHS: repo, MISE_LOCKED: "0" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = decoder.decode(result.stderr);
      assertEquals(result.success, success, text);
      return text;
    }
    const generated = await new Deno.Command("mise", {
      args: [
        "tool-stub",
        join(repo, "plugins/sayt/nu.toml"),
        "-I",
        join(repo, "plugins/sayt"),
        "-c",
        "use auto-bayt.nu; auto-bayt",
      ],
      cwd: app,
      env: { MISE_TRUSTED_CONFIG_PATHS: repo, MISE_LOCKED: "0" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(generated.success, decoder.decode(generated.stderr));
    assertStringIncludes(await gate(), "pronto write:");
    const warm = await gate();
    assertStringIncludes(warm, 'Task "bayt:generate:default" is up to date');
    assert(!warm.includes("pronto write:"), warm);
    const checkerInputs = join(app, ".pronto/check-inputs.json");
    const checkerSnapshot = await Deno.readTextFile(checkerInputs);
    await Deno.remove(checkerInputs);
    assertStringIncludes(await gate(), "pronto write:");
    assertEquals(await Deno.readTextFile(checkerInputs), checkerSnapshot);
    const removed = join(app, "shell/screens/main.html");
    await Deno.remove(removed);
    assertStringIncludes(await gate(), "pronto write:");
    assertStringIncludes(
      await Deno.readTextFile(removed),
      'data-screen="main"',
    );
    const stamp = join(app, ".task/bayt/generate.hash");
    const stampTime = (await Deno.stat(stamp)).mtime;
    await Deno.writeTextFile(
      join(app, "broken.cue"),
      "package jsfb\ncode: meta: name: 0\n",
    );
    await gate(false);
    assertEquals((await Deno.stat(stamp)).mtime, stampTime);
    await Deno.remove(join(app, "broken.cue"));
    assertStringIncludes(await gate(), "pronto write:");
    assertStringIncludes(
      await gate(),
      'Task "bayt:generate:default" is up to date',
    );
    const before = await outputs();
    const screen = join(app, "shell/screens/main.html");
    const mtime = (await Deno.stat(screen)).mtime;
    assertStringIncludes(await build(), "(1 derivation)");
    assertEquals(await outputs(), before);
    assertEquals((await Deno.stat(screen)).mtime, mtime);

    const irPath = join(app, "ir.html");
    const ir = await Deno.readTextFile(irPath);
    const withoutCards = ir.replace(/<!-- pronto:card -->[\s\S]*?<!-- \/pronto:card -->/g, "<!-- pronto:card --><!-- /pronto:card -->");
    assert(withoutCards !== ir);
    await Deno.writeTextFile(irPath, withoutCards);
    const redrawn = await build();
    assertStringIncludes(redrawn, "(1 derivation)");
    assertStringIncludes(redrawn, '"phase":"ir-facts"');
    assertEquals(await Deno.readTextFile(irPath), ir);
    assertEquals(await outputs(), before);

    const { derive } = await import("./derive.ts");
    const derivedIr = await derive(app);
    const changedDecision = ir.replace('data-kind="decision"><strong>', 'data-kind="decision"><strong>Changed decision: ');
    assert(changedDecision !== ir);
    await Deno.writeTextFile(irPath, changedDecision);
    await assertRejects(derivedIr.refreshIr, Error, "authored compiler inputs changed");
    assertEquals(await outputs(), before);
    await Deno.writeTextFile(irPath, ir);

    // Authored markup reaches derivation before the emission settles.
    const source = join(app, "screens.cue");
    const markup = await Deno.readTextFile(source);
    await Deno.writeTextFile(source, markup.replace('class="screen"', 'class="screen presentation-edit"'));
    assertStringIncludes(await build(), "(1 derivation)");
    assertStringIncludes(await Deno.readTextFile(screen), 'class="screen presentation-edit"');
    assertEquals(await Deno.readTextFile(join(app, "program_derived.cue")), before["program_derived.cue"]);
    await Deno.writeTextFile(
      source,
      markup.replace(
        '<section class="screen" data-screen="main">',
        '<section class="screen" data-screen="main"><aside data-live="row" data-filter="id=eq.preview"><template data-item><span data-text="{id}"></span></template></aside>',
      ),
    );
    assertStringIncludes(await gate(), "(2 derivations)");
    assertStringIncludes(await Deno.readTextFile(screen), "id=eq.preview");
    const derived = await Deno.readTextFile(join(app, "program_derived.cue"));
    const old = before["program_derived.cue"];
    assertEquals(
      (derived.match(/table: "row"/g) ?? []).length,
      (old.match(/table: "row"/g) ?? []).length + 1,
    );
    const changed = await outputs();
    assertStringIncludes(await build(), "(1 derivation)");
    assertEquals(await outputs(), changed);

    const css = join(app, "shell/shell.css");
    const originalCss = await Deno.readTextFile(css);
    await Deno.writeTextFile(css, "corrupted output");
    assertStringIncludes(await build(), "(2 derivations)");
    assertEquals(await Deno.readTextFile(css), originalCss);

    const manifestPath = join(app, ".pronto/manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.written.push("obsolete.txt");
    await Deno.writeTextFile(join(app, "obsolete.txt"), "obsolete");
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    assertStringIncludes(await build(), "(2 derivations)");
    await assertRejectsNotFound(join(app, "obsolete.txt"));

    await Deno.writeTextFile(
      join(app, "invalid.cue"),
      'package jsfb\ncode: state: entities: Row: durability: "server"\n',
    );
    assertStringIncludes(await build(false), "conflicting values");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("cold-start preflight reports all missing authored files and owed ids in one pass", async () => {
  const app = await Deno.makeTempDir({
    dir: join(repo, "apps"),
    prefix: ".write-cold-start-",
  });
  const decoder = new TextDecoder();
  try {
    await copyJsfb(app);
    await Deno.remove(join(app, ".pronto/facts.json"));
    const programPath = join(app, "program.cue");
    await Deno.writeTextFile(
      programPath,
      (await Deno.readTextFile(programPath))
        .replace("\t\t\t\tmarkup: _mainMarkup\n", "")
        .replace(/^\t\tir: \{sha256: "[^"]*"\}\n/m, "") +
        '\ncode: surface: handlers: bench: {of: "main", src: "shell/handlers/bench.js", note: "benchmark fold"}\n',
    );
    for (const rel of ["ir.html", "acceptance.md", "DESIGN.md", "journal.html", "shell/screens", "shell/handlers"]) {
      await Deno.remove(join(app, rel), { recursive: true });
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--config",
        join(repo, "plugins/pronto/deno.json"),
        "--allow-read",
        "--allow-write=.",
        "--allow-run",
        "--allow-env",
        writer,
        ".",
      ],
      cwd: app,
      env: { ...Deno.env.toObject(), MISE_TRUSTED_CONFIG_PATHS: repo },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = decoder.decode(result.stderr);
    assertEquals(result.success, false, text);
    assertStringIncludes(text, "ir.html: no such file — author ir.html with owed elements:");
    assertStringIncludes(text, '<article id="main" data-kind="screen" data-route="/">');
    assertStringIncludes(text, "acceptance.md: no such file — author acceptance.md");
    assertStringIncludes(text, "DESIGN.md: no such file");
    assertStringIncludes(text, "journal.html: no such file");
    assertStringIncludes(text, "shell/screens/main.html: no such file");
    assertStringIncludes(text, "shell/screens/main.css does not open");
    assertStringIncludes(text, "shell/handlers/bench.js: missing assembly source");
    assertStringIncludes(text, "accept-run");
    await assertRejectsNotFound(join(app, "DESIGN.md"));
    await assertRejectsNotFound(join(app, ".pronto/facts.json"));
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

async function assertRejectsNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
    return;
  }
  throw new Error(`${path} was not swept`);
}

// A copy of jsfb sits beside it, outside apps/jsfb, so it states its place
// (write.ts holds the build's to the checkout).
async function copyJsfb(app: string): Promise<void> {
  await copyApp(join(repo, "apps/jsfb"), app);
  const dir = `apps/${app.replaceAll("\\", "/").split("/").pop()}`;
  await Deno.writeTextFile(join(app, "place.cue"), `package jsfb\n\nbuild: meta: dir: ${JSON.stringify(dir)}\n`);
}

async function copyApp(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  // Bayt indexes sibling projects; fixtures must not register the copied app's graph.
  for await (const entry of Deno.readDir(source)) {
    if ([".bayt", ".task", "node_modules", "dist", "bayt.cue", "bayt.json"].includes(entry.name)) {
      continue;
    }
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory) await copyApp(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`unsupported fixture entry: ${from}`);
  }
}

Deno.test("Pronto check gates retain consumer rules and track test fixtures", async () => {
  const app = await Deno.makeTempDir({
    dir: join(repo, "apps"),
    prefix: "check-test-",
  });
  const decoder = new TextDecoder();
  // A nested frontend must not inherit the outer Bayt leaf's dispatch identity.
  const commandEnv = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) =>
      !name.startsWith("SAYT_") && !name.startsWith("BAYT_")
    ),
  );
  async function run(args: string[], success = true): Promise<string> {
    const result = await new Deno.Command("mise", {
      args: ["tool-stub", join(repo, "plugins/sayt/nu.toml"), ...args],
      cwd: app,
      clearEnv: true,
      env: {
        ...commandEnv,
        MISE_TRUSTED_CONFIG_PATHS: repo,
        MISE_LOCKED: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = decoder.decode(result.stdout) +
      decoder.decode(result.stderr);
    assertEquals(result.success, success, output);
    return output;
  }
  try {
    await copyJsfb(app);
    await Deno.mkdir(join(app, "pronto"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "pronto/config.cue"),
      `package prontoproject
pronto: say: say: {
  build: rulemap: {builtin: stop: false, custom: {priority: 1, cmds: [{do: "print build-extension"}]}}
  test: keep_going: true
  lint: rulemap: custom: {priority: -1, cmds: [{do: "print lint-extension"}]}
  test: rulemap: custom: {priority: -1, cmds: [{do: "print test-extension"}]}
}
`,
    );
    const build = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        join(repo, "plugins/pronto/deno.json"),
        "--allow-all",
        writer,
        ".",
      ],
      cwd: app,
      env: { ...Deno.env.toObject(), MISE_TRUSTED_CONFIG_PATHS: repo },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(build.success, decoder.decode(build.stderr));
    await run([
      "-I",
      join(repo, "plugins/sayt"),
      "-c",
      "use auto-bayt.nu; auto-bayt",
    ]);
    const checks = await Deno.readTextFile(join(app, ".bayt/checks.yaml"));
    assertStringIncludes(checks, "lint-extension");
    assertStringIncludes(checks, "test-extension");
    assertStringIncludes(checks, "check-proto.ts");
    assertStringIncludes(checks, "check-facts.ts");
    assert(!checks.includes("bayt:test"), checks);
    const publicConfig = await Deno.readTextFile(join(app, ".say.yaml"));
    assertStringIncludes(publicConfig, "bayt-task lint --generate");
    assertStringIncludes(publicConfig, "bayt-task test --generate");
    assert(!publicConfig.includes("lint-extension"), publicConfig);

    assertStringIncludes(
      await run([join(repo, "plugins/sayt/sayt.nu"), "build"]),
      "build-extension",
    );
    assertStringIncludes(publicConfig, "keep_going: true");
    await Deno.writeTextFile(
      join(app, "pronto/config.cue"),
      '\npronto: say: say: test: rulemap: added: {priority: -1, cmds: [{do: "print fresh-check"}]}\n',
      { append: true },
    );
    assertStringIncludes(
      await run([join(repo, "plugins/sayt/sayt.nu"), "test"]),
      "fresh-check",
    );

    // Checks are generated cache outputs; dispatch fixtures must enter through authored rules.
    await Deno.writeTextFile(
      join(app, "pronto/config.cue"),
      "package prontoproject\npronto: say: " + JSON.stringify({
        say: {
          build: { do: "null" },
          lint: {
            copies: [["tests/copy-a.txt", "tests/copy-b.txt"]],
            rulemap: {
              "auto-cue": { priority: -2 },
              dispatch: {
                priority: -1,
                stop: true,
                cmds: [
                  { do: '"lint-one" | save -f .task/lint-one' },
                  { do: '"lint-two" | save -f .task/lint-two' },
                ],
              },
            },
          },
          test: {
            rulemap: {
              dispatch: {
                priority: -100,
                stop: true,
                cmds: [{
                  do:
                    'if (open --raw tests/input.txt | str trim) == "fail" { error make {msg: "fixture failure"} }; open --raw tests/input.txt | save -f .task/test-result',
                }],
              },
            },
          },
          launch: {
            rulemap: {
              dispatch: {
                priority: -100,
                stop: true,
                cmds: [
                  { do: '"prepared" | save -f .task/launch-prepared' },
                  {
                    use: join(app, "tests/capture-args.nu").replaceAll(
                      "\\",
                      "/",
                    ),
                    do: "capture-args launch",
                  },
                ],
              },
            },
          },
          integrate: {
            rulemap: {
              dispatch: {
                priority: -100,
                stop: true,
                cmds: [{ do: "nu tests/capture-args.nu integrate" }],
              },
            },
          },
        },
      }),
    );
    await Deno.writeTextFile(
      join(app, "fixture-build.cue"),
      'package jsfb\nbuild: project: targets: lint: state: globs: [".task/lint-one", ".task/lint-two"]\n',
    );
    await Deno.mkdir(join(app, "tests"), { recursive: true });
    const input = join(app, "tests/input.txt");
    await Deno.writeTextFile(input, "first");
    await Deno.writeTextFile(join(app, "tests/copy-a.txt"), "same");
    await Deno.writeTextFile(join(app, "tests/copy-b.txt"), "same");
    const gate = (verb: string, success = true, args: string[] = []) =>
      run([join(repo, "plugins/sayt/sayt.nu"), verb, ...args], success);
    const firstLint = await gate("lint");
    assertStringIncludes(firstLint, "bayt:generate");
    assertStringIncludes(firstLint, "bayt:lint");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/lint-one")),
      "lint-one",
    );
    assertEquals(
      await Deno.readTextFile(join(app, ".task/lint-two")),
      "lint-two",
    );
    await Deno.remove(join(app, ".task/lint-one"));
    await gate("lint");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/lint-one")),
      "lint-one",
    );
    await Deno.writeTextFile(join(app, "tests/copy-b.txt"), "different");
    const drift = await gate("lint", false);
    assertStringIncludes(drift, "bayt:lint");
    assertStringIncludes(drift, "differs from");
    await Deno.writeTextFile(join(app, "tests/copy-b.txt"), "same");
    await gate("lint");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/lint-one")),
      "lint-one",
    );
    await gate("test");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/test-result")),
      "first",
    );
    await gate("test");
    await Deno.writeTextFile(input, "second");
    await gate("test");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/test-result")),
      "second",
    );

    await Deno.writeTextFile(
      join(app, "tests/capture-args.nu"),
      `export def --wrapped main [verb: string, ...args] {
  if "--fail" in $args { error make {msg: "action failure"} }
  $args | to json | save -f ($".task/($verb)-args.json")
}
`,
    );
    const actionArgs = ["--watch", "--target", "a target with spaces"];
    await gate("launch", true, actionArgs);
    const launchArgs = join(app, ".task/launch-args.json");
    assertEquals(JSON.parse(await Deno.readTextFile(launchArgs)), actionArgs);
    await Deno.remove(launchArgs);
    await gate("launch", true, actionArgs);
    assertEquals(JSON.parse(await Deno.readTextFile(launchArgs)), actionArgs);
    const integrateArgs = ["--no-cache", "--progress", "plain"];
    await gate("integrate", true, integrateArgs);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(join(app, ".task/integrate-args.json")),
      ),
      integrateArgs,
    );
    const cachedArgs = ["--progress", "plain"];
    await gate("integrate", true, cachedArgs);
    assertStringIncludes(await gate("integrate", true, cachedArgs), "task-leaf integrate");
    await Deno.writeTextFile(input, "integration edit");
    assertStringIncludes(await gate("integrate", true, cachedArgs), "task-leaf integrate");
    assertStringIncludes(await gate("integrate", true, integrateArgs), "task-leaf integrate");
    assertStringIncludes(await gate("integrate", true, integrateArgs), "task-leaf integrate");
    assertStringIncludes(
      await gate("integrate", false, ["--fail"]),
      "action failure",
    );

    await Deno.writeTextFile(input, "fail");
    assertStringIncludes(await gate("test", false), "fixture failure");
    assertEquals(
      await Deno.readTextFile(join(app, ".task/test-result")),
      "second",
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("writer packages Activepieces assets and sweeps only stale generated copies", async () => {
  const app = await Deno.makeTempDir({dir: join(repo, "apps"), prefix: ".write-piece-"});
  const build = async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", join(repo, "plugins/pronto/deno.json"), "--allow-all", writer, "."],
      cwd: app,
      env: { MISE_TRUSTED_CONFIG_PATHS: repo, MISE_LOCKED: "0" },
      stdout: "piped", stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
  };
  try {
    await copyJsfb(app);
    for await (const entry of Deno.readDir(app)) {
      if (entry.isFile && entry.name.endsWith(".cue")) {
        const path = join(app, entry.name);
        await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace(/^package jsfb$/m, "package write_piece_fixture"));
      }
    }
    const program = join(app, "program.cue");
    await Deno.writeTextFile(program, (await Deno.readTextFile(program)).replace('targets: ["pages"]', 'targets: ["docker"]')
      .replace('name:        "jsfb"', 'name:        "write-piece-fixture"') + `
code: meta: clocks: ["docker"]
code: capabilities: auth: {required: false, service: "/auth"}
code: state: {
  entities: Payment: {
    id: "0xc75ee275aaa2d972", table: "payment", durability: "server"
    fields: [{name: "id", ordinal: 1, type: "uuid", pk: true}, {name: "status", ordinal: 2, type: "string"}]
  }
  mecha: rows: PaymentMachine: {
    entity: "Payment", field: "status", initial: "pending"
    states: {
      pending: on: start: "running"
      running: invoke: {src: "send", onDone: "done", onError: "failed"}
      done: type: "final"
      failed: type: "final"
    }
  }
  bridges: integration: {container: "integrations", action: "parse"}
  effects: send: {sink: {bridge: "integration", idempotent: false}, reentry: "unknown", note: "the result may be uncertain"}
}
code: capabilities: hatches: integrations: {
  kind: "container", note: "test integration"
  activepieces: {
    lock: "./pieces/integrations.lock"
    pieces: sample: {local: "./pieces/sample", export: "sample"}
    pieces: http: {npm: {package: "@activepieces/piece-http", version: "0.13.0", export: "http"}}
    actions: parse: {
      piece: "http", action: "parse_url"
      inputSchema: "./pieces/http/parse.input.schema.json"
      outputSchema: "./pieces/http/parse.output.schema.json"
      fixedProps: {returnArrays: true}
    }
    actions: invoke: {
      piece: "sample", action: "invoke"
      inputSchema: "./pieces/sample/invoke.input.schema.json"
      outputSchema: "./pieces/sample/invoke.output.schema.json"
    }
  }
}
`);
    await Deno.mkdir(join(app, "effects"), {recursive: true});
    await Deno.writeTextFile(join(app, "effects/send.js"), '(input, sink) => sink.fetch("/", {method: "POST", body: {props: input}})');
    const ir = join(app, "ir.html");
    await Deno.writeTextFile(ir, (await Deno.readTextFile(ir)).replace('</body>', '<section id="integrations" data-kind="hatch" data-hatch-kind="container">Test integration.</section>\n</body>'));
    const source = join(app, "pieces/sample");
    await Deno.mkdir(source, {recursive: true});
    await Deno.writeTextFile(join(source, "package.json"), '{"exports":"./index.js"}');
    await Deno.writeTextFile(join(source, "index.js"), 'export const sample = {};');
    for (const name of ["invoke.input.schema.json", "invoke.output.schema.json"]) await Deno.writeTextFile(join(source, name), '{"type":"object"}');
    const authoredLock = join(app, "pieces/integrations.lock");
    const fixture = join(repo, "plugins/pronto/testdata/activepieces");
    await Deno.copyFile(join(fixture, "pieces/npm.lock"), authoredLock);
    await Deno.mkdir(join(app, "pieces/http"), {recursive: true});
    for (const kind of ["input", "output"]) await Deno.copyFile(join(fixture, `pieces/http/parse.${kind}.schema.json`), join(app, `pieces/http/parse.${kind}.schema.json`));
    const lock = await Deno.readFile(authoredLock);
    const binary = new Uint8Array([0, 255, 128, 10]);
    await Deno.writeFile(join(source, "asset.bin"), binary);
    await build();
    const context = join(app, "activepieces/integrations");
    const generated = join(context, "pieces/sample/asset.bin");
    assertEquals(await Deno.readFile(generated), binary);
    assertEquals(JSON.parse(await Deno.readTextFile(join(context, "manifest.json"))).actions.invoke.inputSchema, {type: "object"});
    assertStringIncludes(await Deno.readTextFile(join(context, "registry.ts")), 'from "./pieces/sample/index.js"');
    assertStringIncludes(await Deno.readTextFile(join(app, "services/airlock/dapr/send.yaml")), "http://integrations:8080/actions/parse");
    const manifestPath = join(app, ".pronto/manifest.json");
    const recorded = JSON.parse(await Deno.readTextFile(manifestPath));
    assert(recorded.written.includes("activepieces/integrations/pieces/sample/asset.bin"));
    const time = (await Deno.stat(generated)).mtime;
    await build();
    assertEquals((await Deno.stat(generated)).mtime, time);
    await Deno.rename(join(source, "asset.bin"), join(source, "renamed.bin"));
    await build();
    await assertRejectsNotFound(generated);
    assert(!JSON.parse(await Deno.readTextFile(manifestPath)).written.includes("activepieces/integrations/pieces/sample/asset.bin"));
    assertEquals(await Deno.readFile(join(context, "pieces/sample/renamed.bin")), binary);
    assertEquals(await Deno.readFile(join(source, "renamed.bin")), binary);
    assertEquals(await Deno.readFile(authoredLock), lock);
    await Deno.writeTextFile(program, (await Deno.readTextFile(program))
      .replace('    pieces: sample: {local: "./pieces/sample", export: "sample"}\n', "")
      .replace(/    actions: invoke: \{[\s\S]*?\n    \}\n/, ""));
    await build();
    await runGeneratedActivepieces(context);
  } finally { await Deno.remove(app, {recursive: true}); }
});

async function runGeneratedActivepieces(context: string): Promise<void> {
  const runner = join(repo, "libraries/mecha/services/activepieces");
  // The runner starts --cached-only, and a fresh machine holds neither graph.
  for (const [config, entry] of [[`${context}/deno.json`, `${context}/registry.ts`], [`${runner}/deno.json`, `${runner}/main.ts`]]) {
    const cache = await new Deno.Command(Deno.execPath(), {
      args: ["cache", "--frozen", `--config=${config}`, entry],
      stdout: "null", stderr: "piped",
    }).output();
    assert(cache.success, new TextDecoder().decode(cache.stderr));
  }
  const socket = Deno.listen({hostname: "127.0.0.1", port: 0});
  const port = (socket.addr as Deno.NetAddr).port;
  socket.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--frozen", "--cached-only", `--config=${runner}/deno.json`, "--allow-env", "--allow-read", "--allow-net", "--allow-run", `${runner}/main.ts`],
    env: {ACTIVEPIECES_MANIFEST: `${context}/manifest.json`, ACTIVEPIECES_REGISTRY: `${context}/registry.ts`, PORT: String(port)},
    stdout: "null", stderr: "inherit",
  }).spawn();
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${base}/ready`); ready = true; break; }
      catch (error) { if (!(error instanceof TypeError)) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert(ready, "runner did not become ready");
    const response = await fetch(`${base}/actions/parse/`, {
      method: "POST", headers: {"Content-Type": "application/json", "Idempotency-Key": "fixture-key"},
      body: JSON.stringify({props: {url: "https://example.test/?a=1&a=2"}}),
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).result.query_parameters, {a: ["1", "2"]});
  } finally {
    try { child.kill("SIGKILL"); } catch (error) {
      if (!(error instanceof TypeError && error.message === "Child process has already terminated")) throw error;
    }
    await child.status;
  }
}
