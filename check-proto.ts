// pronto proto lint: buf breaking over every proto the app does not withhold.
//
//   deno run --allow-read --allow-run --allow-env \
//     ../../plugins/pronto/check-proto.ts <appDir> [branch]
//
// The emitted buf.yaml sets the module to the app itself, so the set is every
// proto under the app — the emitted entities.proto and whatever a hatch brought
// beside it — minus the paths a `proto`-kind hatch names. Adding a proto cannot
// quietly escape the comparison, and escaping it is a declaration that, because
// every hatch carries `ir`, also stands in ir.html.
//
// What it compares against is the app's own git history, read through buf's git
// input. The subdirectory is asked of git rather than written down: in this
// monorepo the app sits at apps/<name>, and in the repo copybara gives it it is
// the root, so a path spelled here would be right in one and wrong in the
// other. `git rev-parse --show-prefix` answers correctly in both.
//
// The rule that matters is WIRE_JSON. The emitter writes json_name on every
// field, so a holder reads the JSON by name: a rename survives binary decoding
// and breaks every reader of the JSON, which is why it has to be refused rather
// than inferred.
//
// It is refused nowhere else, which is the reason this pass exists. A rename
// spelled in program.cue alone is caught by identity.ts, but as a disagreement
// with ir.html rather than as a rename — so renaming the ir row too satisfies
// it, and `lost()` pairs fields by ordinal and never compares the name.
// Measured: with both files renamed consistently, identity reports nothing and
// this pass reports FIELD_SAME_NAME and FIELD_SAME_JSON_NAME.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any error is reported.

import { exportJson } from "./cue.ts";
type Finding = { severity: "error" | "advisory"; path: string; message: string };

type Hatch = { kind: string; files?: string[]; note: string };

/** Where the comparison looks when nothing says otherwise. */
const DEFAULT_BRANCH = "main";

async function git(appDir: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: appDir, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** The paths the comparison skips, each with the reason it is skipped. */
export function withheld(hatches: Record<string, Hatch>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, h] of Object.entries(hatches)) {
    if (h.kind !== "proto") continue;
    for (const f of h.files ?? []) out.set(f, `hatch ${name}: ${h.note}`);
  }
  return out;
}

/**
 * buf's git input for the app, whatever repo it is sitting in. The common dir
 * is asked for rather than assumed because a worktree's `.git` is a file that
 * points elsewhere, and buf needs the directory it points at.
 */
export function gitInput(commonDir: string, prefix: string, branch: string): string {
  const subdir = prefix.replace(/\/$/, "");
  return subdir === "" ? `${commonDir}#branch=${branch}` : `${commonDir}#branch=${branch},subdir=${subdir}`;
}

/** buf's `file:line:col:message` lines as lint findings. */
export function findings(stdout: string): Finding[] {
  const out: Finding[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(text);
    out.push({
      severity: "error",
      path: m ? m[1] : "schema/entities.proto",
      message: m ? `${m[1]}:${m[2]} ${m[4].trim()}` : text,
    });
  }
  return out;
}

async function main(appDir: string, branch: string) {
  // Three absences, and only the middle one is an answer. They are settled
  // before the hatches are read: whether git can answer at all does not depend
  // on what the app declares, and asking first keeps the failure about the
  // missing repository rather than about a CUE export that ran in a tree the
  // comparison was never going to be able to grade.
  //
  // No repository at all is a missing precondition: the comparison is against
  // git history, so somewhere without git cannot produce a verdict. It has to
  // say so, because `rev-parse --verify HEAD` fails identically here and in the
  // case below — both exit 128 — so reading that alone would report "no history
  // to compare" about a tree that simply was not a checkout.
  const inRepo = await new Deno.Command("git", {
    args: ["rev-parse", "--git-dir"],
    cwd: appDir,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!inRepo.success) {
    throw new Error(`${appDir} is not in a git repository, so there is no history to compare against`);
  }

  // A repository with no commits yet has nothing to compare against, and that
  // is the one absence this treats as an answer.
  const anyHistory = await new Deno.Command("git", {
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: appDir,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!anyHistory.success) {
    console.log(JSON.stringify([], null, 2));
    return;
  }
  // A branch missing from a repository which HAS history is a misconfiguration
  // — a renamed default branch, a shallow clone — and passing it silently would
  // leave a gate that reads green while comparing nothing.
  const known = await new Deno.Command("git", {
    args: ["rev-parse", "--verify", `${branch}^{commit}`],
    cwd: appDir,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!known.success) {
    throw new Error(`this repository has history but no "${branch}" to compare against; name the branch to compare with as the second argument`);
  }

  const hatches = await exportJson<Record<string, Hatch>>(appDir, "code.capabilities.hatches");
  const skip = withheld(hatches);

  const commonDir = await git(appDir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const prefix = await git(appDir, "rev-parse", "--show-prefix");
  const against = gitInput(commonDir, prefix, branch);

  const excludes = [...skip.keys()].flatMap((f) => ["--exclude-path", f]);
  const out = await new Deno.Command("mise", {
    args: ["x", "--", "buf", "breaking", "--against", against, ...excludes],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  // buf reports breakages on stdout and exits non-zero; a non-zero exit with
  // nothing on stdout is buf failing to run, which is not a clean verdict.
  if (!out.success && stdout === "") throw new Error(`buf breaking failed: ${stderr || `exit ${out.code}`}`);

  const found = findings(stdout);
  console.log(JSON.stringify(found, null, 2));
  if (found.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  await main(Deno.args[0] ?? ".", Deno.args[1] ?? DEFAULT_BRANCH);
}
