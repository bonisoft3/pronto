import { exists } from "./missing.ts";

// Keep consumer contributions and program-derived rules under CUE unification.
export async function projectSay(
  appDir: string,
  programSay: unknown,
): Promise<unknown> {
  if (!(await exists(`${appDir}/pronto/config.cue`))) return programSay;
  const child = new Deno.Command("cue", {
    args: [
      "export",
      "./pronto",
      "json:",
      "-",
      "-e",
      "pronto.say",
      "--out",
      "json",
    ],
    cwd: appDir,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const input = child.stdin.getWriter();
  await input.write(
    new TextEncoder().encode(JSON.stringify({
      pronto: {
        say: programSay,
      },
    })),
  );
  await input.close();
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      "consumer configuration conflicts with the program's Sayt rules",
    );
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

// Gate every declared platform; execution options belong to the original leaf.
export function projectGates(
  checks: Record<string, unknown>,
  gates: Record<string, unknown>,
) {
  const projected: Record<string, unknown> = { ...gates };
  const say = Object.fromEntries(
    Object.keys({ ...checks, ...gates }).map((name) => {
      const settings = checks[name] ?? {};
      if (!(name in gates)) return [name, settings];
      const {
        rulemap,
        rules: _normalized,
        do: _command,
        args: _args,
        ...options
      } = settings as Record<string, unknown>;
      const gate = gates[name] as { rulemap: Record<string, unknown> };
      const platforms = [
        ...new Set(
          Object.values(
            (rulemap ?? {}) as Record<string, { platform?: string } | null>,
          )
            .flatMap((rule) => rule?.platform ? [rule.platform] : []),
        ),
      ];
      const dispatch = Object.fromEntries(platforms.map((platform, index) => [
        `platform-${index}`,
        {
          ...gate.rulemap.builtin as Record<string, unknown>,
          platform,
          priority: -1,
        },
      ]));
      const delegated = { ...gate, rulemap: { ...gate.rulemap, ...dispatch } };
      projected[name] = delegated;
      return [name, { ...options, ...delegated }];
    }),
  );
  return { say, gates: projected };
}
