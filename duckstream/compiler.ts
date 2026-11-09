import {
  parse,
  type Plan,
  require,
  type Schema,
  translate,
} from "./translator.ts";
import { ifMissing } from "../missing.ts";
import {
  checkDiagnostics,
  type Diagnostic,
  readDiagnostics,
} from "./diagnostics.ts";

export const compiler = {
  version: "0.367.0",
  sha256: "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab",
  image:
    "images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272",
  jar: "/home/ubuntu/feldera/build/sql2dbsp-jar-with-dependencies.jar",
  flags: [
    "-i",
    "--alltables",
    "-v",
    "1",
    "-T",
    "SqlToRelCompiler=2",
    "--noRust",
  ],
} as const;

export interface CompileOptions {
  sourcePath: string;
  outputDirectory: string;
  view?: string;
  jarPath?: string;
}
export interface ProgramOptions extends Omit<CompileOptions, "view"> {
  views: string[];
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function currentCompilerHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (
    const [name, path] of Object.entries({
      translator: "translator.ts",
      driver: "compiler.ts",
      admission: "diagnostics.ts",
    })
  ) {
    hashes[name] = await sha256(
      await Deno.readFile(new URL(path, import.meta.url)),
    );
  }
  return hashes;
}

async function command(name: string, args: string[]) {
  const result = await new Deno.Command(name, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  require(
    result.success,
    `${name} exited ${result.code}\n${decoder.decode(result.stdout)}\n${
      decoder.decode(result.stderr)
    }`,
  );
  return decoder.decode(result.stdout) + "\n" + decoder.decode(result.stderr);
}

async function artifacts(options: ProgramOptions) {
  const directory = await Deno.realPath(options.outputDirectory);
  const planText = await Deno.readTextFile(`${directory}/plan.json`);
  const schemaText = await Deno.readTextFile(`${directory}/schema.json`);
  const plan = parse(planText) as Plan;
  const schema = parse(schemaText) as Schema;
  const diagnosticsText = await Deno.readTextFile(
    `${directory}/diagnostics.json`,
  );
  checkDiagnostics(JSON.parse(diagnosticsText) as Diagnostic[], plan);
  require(
    options.views.length > 0 &&
      new Set(options.views).size === options.views.length,
    "distinct output views",
  );
  const queries: Record<string, string> = {};
  for (const view of options.views) {
    require(
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(view),
      "output filename identifier",
    );
    queries[view] = translate(plan, schema, view);
  }
  const files: Record<string, Uint8Array> = {
    source: await Deno.readFile(options.sourcePath),
    plan: new TextEncoder().encode(planText),
    schema: new TextEncoder().encode(schemaText),
    diagnostics: new TextEncoder().encode(diagnosticsText),
  };
  for (const [view, sql] of Object.entries(queries)) {
    files[`${view}.sql`] = new TextEncoder().encode(sql);
  }
  const hashes = await currentCompilerHashes();
  for (const [name, bytes] of Object.entries(files)) {
    hashes[name] = await sha256(bytes);
  }
  return {
    queries,
    plan,
    schema,
    manifest: { format: 1, compiler, views: options.views, hashes },
  };
}

export async function compileProgram(options: ProgramOptions) {
  await Deno.mkdir(options.outputDirectory, { recursive: true });
  const directory = await Deno.realPath(options.outputDirectory);
  const source = await Deno.realPath(options.sourcePath);
  // Checked even when the output is reused, so a wrong jar fails here and not
  // at the next unrelated edit.
  const jar = options.jarPath
    ? await Deno.realPath(options.jarPath)
    : undefined;
  if (jar !== undefined) await judgeJar(jar);
  if (!(await compiledFrom(directory, source))) {
    await runCompiler(directory, source, jar);
  }
  const result = await artifacts(options);
  for (const [view, sql] of Object.entries(result.queries)) {
    await Deno.writeTextFile(`${directory}/${view}.sql`, sql);
  }
  await Deno.writeTextFile(
    `${directory}/manifest.json`,
    JSON.stringify(result.manifest, null, 2) + "\n",
  );
  return result;
}

/** Whether the directory holds this compiler's output for this source: that
 * output is a function of the two alone, and the manifest names both, the code
 * that read diagnostics.json off it, and the hash of each output. */
// One judgement per jar for the process: a build compiles several programs.
const judged = new Map<string, Promise<void>>();
function judgeJar(jar: string): Promise<void> {
  let judgement = judged.get(jar);
  if (judgement === undefined) {
    judgement = (async () =>
      require(
        await sha256(await Deno.readFile(jar)) === compiler.sha256,
        "compiler artifact hash",
      ))();
    judged.set(jar, judgement);
  }
  return judgement;
}

export async function compiledFrom(directory: string, source: string) {
  const text = await ifMissing(
    Deno.readTextFile(`${directory}/manifest.json`),
    null,
  );
  if (text === null) return false;
  // A manifest cut short or left mid-merge names nothing to trust, and the
  // compile this answer asks for overwrites it.
  let manifest: { format?: unknown; compiler?: unknown; hashes?: unknown };
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    throw e;
  }
  if (
    manifest === null || typeof manifest !== "object" ||
    manifest.format !== 1 || manifest.hashes === null ||
    typeof manifest.hashes !== "object"
  ) return false;
  const hashes = manifest.hashes as Record<string, unknown>;
  if (JSON.stringify(manifest.compiler) !== JSON.stringify(compiler)) {
    return false;
  }
  for (const [name, hash] of Object.entries(await currentCompilerHashes())) {
    if (hashes[name] !== hash) return false;
  }
  if (hashes.source !== await sha256(await Deno.readFile(source))) {
    return false;
  }
  for (const name of ["plan", "schema", "diagnostics"]) {
    const bytes = await ifMissing(
      Deno.readFile(`${directory}/${name}.json`),
      null,
    );
    if (bytes === null || hashes[name] !== await sha256(bytes)) {
      return false;
    }
  }
  return true;
}

async function runCompiler(directory: string, source: string, jar?: string) {
  let diagnostics: string;
  if (jar !== undefined) {
    diagnostics = await command("java", [
      "-jar",
      jar,
      ...compiler.flags,
      "--plan",
      `${directory}/plan.json`,
      "--js",
      `${directory}/schema.json`,
      source,
    ]);
  } else {
    diagnostics = await command("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${Deno.uid()}:${Deno.gid()}`,
      "--group-add",
      "1000",
      "--entrypoint",
      "java",
      "--mount",
      `type=bind,source=${source},target=/input.sql,readonly`,
      "--mount",
      `type=bind,source=${directory},target=/output`,
      compiler.image,
      "-jar",
      compiler.jar,
      ...compiler.flags,
      "--plan",
      "/output/plan.json",
      "--js",
      "/output/schema.json",
      "/input.sql",
    ]);
  }
  const plan = parse(await Deno.readTextFile(`${directory}/plan.json`)) as Plan;
  await Deno.writeTextFile(
    `${directory}/diagnostics.json`,
    JSON.stringify(readDiagnostics(diagnostics, plan), null, 2) + "\n",
  );
}

export async function checkCompiledProgram(
  options: Omit<ProgramOptions, "jarPath">,
) {
  const result = await artifacts(options);
  const directory = await Deno.realPath(options.outputDirectory);
  const manifest = JSON.parse(
    await Deno.readTextFile(`${directory}/manifest.json`),
  );
  require(
    JSON.stringify(manifest) === JSON.stringify(result.manifest),
    "stale compiled SQL provenance; regenerate",
  );
  for (const [view, sql] of Object.entries(result.queries)) {
    require(
      await Deno.readTextFile(`${directory}/${view}.sql`) === sql,
      "stale generated DuckDB SQL; regenerate",
    );
  }
  return result;
}

export async function compileSql(options: CompileOptions) {
  const view = options.view ?? "result";
  const result = await compileProgram({ ...options, views: [view] });
  return { ...result, sql: result.queries[view] };
}

export async function checkCompiledSql(
  options: Omit<CompileOptions, "jarPath">,
) {
  const view = options.view ?? "result";
  const result = await checkCompiledProgram({ ...options, views: [view] });
  return { ...result, sql: result.queries[view] };
}
