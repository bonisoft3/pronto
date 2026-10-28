// verify.ts — CLI entry point and post-release verification orchestrator across live deployments.
//
// Supports:
//   sayt verify@cloudflare
//   sayt verify@k8s
//   sayt verify@gcp
//   sayt verify@<target> --target=https://staging.example.com
//   APP_URL=https://... sayt verify@<target>

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyHttp, type EdgeHints, type EdgeRoute } from "./http-sweep.ts";
import { verifyBrowser } from "./browser-sweep.ts";

function parseArgs(args: string[]) {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

async function loadHints(appDir: string, platform: string): Promise<EdgeHints> {
  if (platform === "cloudflare") {
    const hintsPath = path.join(appDir, "dist/cloudflare/src/hints.json");
    try {
      const text = await Deno.readTextFile(hintsPath);
      return JSON.parse(text) as EdgeHints;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      // Not present locally (e.g. verifying a remote live deployment); fall back to shell.json
    }
  }

  // Container releases (k8s, gcp, docker), static pages, and remote edge releases derive route and screen metadata from shell.json
  const shellPath = path.join(appDir, "shell/shell.json");
  try {
    const text = await Deno.readTextFile(shellPath);
    const shell = JSON.parse(text);
    const routes: EdgeRoute[] = (shell.routes ?? []).map((r: any) => {
      let screen = r.screen;
      if (!screen && r.files?.html) {
        screen = path.basename(r.files.html, ".html");
      }
      return {
        path: r.path,
        screen,
        screens: screen ? [screen] : (r.screens ?? []),
        paths: r.paths,
        links: [],
        files: r.files,
        access: r.access,
      };
    });
    const catalogues: Record<string, string> = {};
    if (platform !== "pages" && shell.i18n?.locales) {
      for (const loc of Object.keys(shell.i18n.locales)) {
        catalogues[loc] = `/messages/${loc}.json`;
      }
    }
    return {
      routes,
      catalogues,
      prefix: shell.prefix,
      i18n: shell.i18n,
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `Missing shell metadata: ${shellPath}. Expected Pronto app shell definition.`
      );
    }
    throw e;
  }
}

async function resolveTargetUrl(
  appDir: string,
  platform: string,
  flags: Record<string, string>
): Promise<string> {
  // 1. Explicit --target flag
  if (flags.target) {
    return flags.target;
  }

  // 2. SAY_VERIFY_ARGS_TARGET from sayt forward
  const saytTarget = Deno.env.get("SAY_VERIFY_ARGS_TARGET");
  if (saytTarget) {
    return saytTarget;
  }

  // 3. APP_URL or PRONTO_DEPLOYED_URL environment variable
  const envUrl = Deno.env.get("APP_URL") ?? Deno.env.get("PRONTO_DEPLOYED_URL");
  if (envUrl) {
    return envUrl;
  }

  // 4. --default-domain flag passed from emit.cue / program.cue
  if (flags["default-domain"]) {
    const domain = flags["default-domain"];
    return domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`;
  }

  // 5. Platform-specific saved deployment metadata
  if (platform === "cloudflare") {
    for (const candidate of [
      path.join(appDir, "dist/cloudflare/origin.txt"),
      path.join(appDir, ".bayt/cloudflare/origin.txt"),
    ]) {
      try {
        const saved = (await Deno.readTextFile(candidate)).trim();
        if (saved) return saved;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }

    try {
      const wranglerText = await Deno.readTextFile(
        path.join(appDir, "dist/cloudflare/wrangler.jsonc")
      );
      const routesMatch = /"pattern":\s*"([^"]+)"/.exec(wranglerText);
      if (routesMatch) {
        const pattern = routesMatch[1].replace(/\/\*.*$/, "");
        return `https://${pattern}`;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  throw new Error(
    `Target URL could not be resolved for platform '${platform}'. Specify --target=https://... or set APP_URL.`
  );
}

export async function main(argv = Deno.args) {
  const { flags, positionals } = parseArgs(argv);
  const appDir = positionals[0] ? path.resolve(positionals[0]) : Deno.cwd();
  const platform = flags.platform ?? Deno.env.get("SAYT_PLATFORM") ?? "cloudflare";
  const tier = flags.tier ?? Deno.env.get("SAY_VERIFY_ARGS_TIER") ?? "all";
  if (tier !== "all" && tier !== "1" && tier !== "2") {
    throw new Error(`Invalid verification tier '${tier}'. Valid options are 'all', '1', or '2'.`);
  }
  const targetUrl = await resolveTargetUrl(appDir, platform, flags);

  console.log(`Verifying deployment at ${targetUrl} (platform: ${platform})`);
  const startTime = Date.now();

  const hints = await loadHints(appDir, platform);
  let publicDir: string | undefined = undefined;
  if (platform === "pages") {
    const dir = path.join(appDir, "dist/browser");
    try {
      const stat = await Deno.stat(dir);
      if (!stat.isDirectory) throw new Error(`${dir} is not a directory`);
      publicDir = dir;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(
          `Missing Pages build artifacts at ${dir}. Run 'sayt release@pages' before verifying.`
        );
      }
      throw e;
    }
  } else if (platform === "cloudflare") {
    const dir = path.join(appDir, "dist/cloudflare/public");
    try {
      const stat = await Deno.stat(dir);
      if (!stat.isDirectory) throw new Error(`${dir} is not a directory`);
      publicDir = dir;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      // Not present locally; verifyHttp will harvest the asset matrix from the live entry document
    }
  } else if (platform === "k8s" || platform === "gcp") {
    for (const candidate of ["dist/container", "served", ".bayt/served"]) {
      const dir = path.join(appDir, candidate);
      try {
        const stat = await Deno.stat(dir);
        if (stat.isDirectory) {
          publicDir = dir;
          break;
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        // Not present locally; verifyHttp will harvest the asset matrix from the live entry document
      }
    }
  }

  let screenRoutes: Map<string, string> | undefined = undefined;

  // Tier 1: Fast HTTP Asset and Cold-Cache Sweep
  if (tier === "all" || tier === "1") {
    console.log("\n[Tier 1] HTTP Cold-Cache & Asset Sweep...");
    const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;
    const httpResult = await verifyHttp(targetUrl, {
      hints,
      publicDir,
      appDir,
      platform,
      timeoutMs,
    });
    screenRoutes = httpResult.screenRoutes;

    console.log(
      `  - ${httpResult.assetsChecked} immutable assets checked (200 + max-age=31536000, immutable)`
    );
    console.log(`  - ${httpResult.cataloguesChecked} catalogues checked (200)`);
    console.log(`  - ${httpResult.routesChecked} document routes checked (200 text/html)`);
    console.log(
      `  - Negative 404 cache poisoning probe: ${httpResult.negativeProbeChecked ? "passed" : "failed"}`
    );

    if (!httpResult.passed) {
      console.error("\nTier 1 Verification Failed:");
      for (const err of httpResult.errors) {
        console.error(`  ✖ ${err}`);
      }
      Deno.exit(1);
    }
    console.log("  ✔ Tier 1 passed cleanly.");
  }

  // Tier 2: Browser User Journey Sweep
  if (tier === "all" || tier === "2") {
    console.log("\n[Tier 2] Browser User Journey Sweep...");

    // Check if custom verification journeys are defined in the app
    let customJourneys: any[] | undefined = undefined;
    const verifyScriptPath = path.join(appDir, "tests/verify.ts");
    let hasCustomScript = false;
    try {
      hasCustomScript = (await Deno.stat(verifyScriptPath)).isFile;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    if (hasCustomScript) {
      const mod = await import(pathToFileURL(verifyScriptPath).href);
      if (Array.isArray(mod.journeys)) {
        customJourneys = mod.journeys;
      } else if (Array.isArray(mod.airlocks)) {
        customJourneys = mod.airlocks;
      } else {
        throw new Error(
          `Custom verification module at ${verifyScriptPath} must export a 'journeys' or 'airlocks' array`
        );
      }
    }

    const headlessFlag = flags.headless ?? Deno.env.get("SAY_VERIFY_ARGS_HEADLESS");
    const rawSession = flags.session ?? Deno.env.get("SAY_VERIFY_ARGS_SESSION");
    const session = rawSession ? JSON.parse(rawSession) : undefined;

    const screenTimeoutMs = flags.timeout ? Number(flags.timeout) : 45000;

    const browserResult = await verifyBrowser({
      targetUrl,
      hints,
      screenRoutes,
      journeys: customJourneys,
      headless: headlessFlag !== "false",
      platform,
      session,
      screenTimeoutMs,
    });

    console.log(`  - ${browserResult.journeysRun} user journeys executed`);
    console.log(`  - ${browserResult.screensChecked} unique screens verified`);
    console.log("  - Zero-tolerance network trap: zero 4xx/5xx or request aborts");

    if (!browserResult.passed) {
      console.error("\nTier 2 Verification Failed:");
      for (const err of browserResult.errors) {
        console.error(`  ✖ ${err}`);
      }
      Deno.exit(1);
    }
    console.log("  ✔ Tier 2 passed cleanly.");
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n✔ Verification successful on ${targetUrl} in ${elapsed}ms.`);
}

if (import.meta.main) {
  await main();
}
