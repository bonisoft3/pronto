// release@gcp's local pre-gate runs the drivers its rc gate runs (gcp/verify.nu's
// selection), as host commands against the local door.
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { localDrivers } from "./local-drivers.ts";

const scenarios = ["mise", "x", "--", "sh", "-c", "deno run --allow-all tests/scenarios.ts"];
const lint = ["deno", "run", "--unsafely-ignore-certificate-errors=caddy", "/omnishell/check-visual.ts", "."];
const config = {
  services: {
    "check-online": { environment: { APP_URL: "https://caddy:8443", ORIGIN: "https://localhost:17218", SETTLE_TIMEOUT_MS: 50000 }, command: scenarios },
    "check-premium": { environment: { APP_URL: "https://caddy:8443" }, entrypoint: ["deno"], command: ["run", "--unsafely-ignore-certificate-errors=caddy", "/omnishell/x.ts"] },
    integrate: { environment: { APP_URL: "https://caddy:8443" }, command: lint },
    // bayt's base of a driver only describes its build, and the gate runs none.
    "app-check-online": { environment: { APP_URL: "https://caddy:8443" }, scale: 0, command: scenarios },
    crud: { environment: { PORT: "3000" }, command: ["crud"] },
  },
};

Deno.test("the drivers the rc gate runs, but the visual lint integrate@local runs already", () => {
  const ds = localDrivers(config, "https://localhost:5555", "/os");
  assertEquals(ds.map((d) => d.name), ["check-online", "check-premium"]);
  assertEquals(ds[0].cmd, scenarios);
});

Deno.test("each driver reaches the local door, and omnishell where the toolchain has it", () => {
  const [online, premium] = localDrivers(config, "https://localhost:5555", "/os");
  assertEquals(online.env, { APP_URL: "https://localhost:5555", ORIGIN: "https://localhost:5555", SETTLE_TIMEOUT_MS: "50000" });
  assertEquals(premium.env, { APP_URL: "https://localhost:5555" });
  assertEquals(premium.cmd, ["deno", "run", "--unsafely-ignore-certificate-errors=localhost", "/os/x.ts"]);
});

// A pre-gate that ran nothing would pass a release the rc gate fails.
Deno.test("an app with no driver, or one with no command, is refused", () => {
  assertThrows(() => localDrivers({ services: { crud: { environment: { PORT: "1" } } } }, "https://localhost:1", "/os"), Error, "no service");
  assertThrows(() => localDrivers({ services: { d: { environment: { APP_URL: "https://caddy:1" } } } }, "https://localhost:1", "/os"), Error, "names no command");
});
