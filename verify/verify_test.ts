import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { main } from "./verify.ts";

Deno.test("verify CLI fails when target cannot be resolved", async () => {
  const originalAppUrl = Deno.env.get("APP_URL");
  try {
    Deno.env.delete("APP_URL");
    const tempDir = await Deno.makeTempDir();
    try {
      await assertRejects(
        async () => {
          await main([tempDir]);
        },
        Error,
        "Target URL could not be resolved"
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  } finally {
    if (originalAppUrl) {
      Deno.env.set("APP_URL", originalAppUrl);
    }
  }
});

Deno.test("verify CLI fails when Cloudflare release hints and shell metadata are missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await assertRejects(
      async () => {
        await main([tempDir, "--target=https://app.example.com", "--platform=cloudflare"]);
      },
      Error,
      "Missing shell metadata"
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verify CLI fails when shell metadata is missing for container platforms", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await assertRejects(
      async () => {
        await main([tempDir, "--target=https://app.example.com", "--platform=k8s"]);
      },
      Error,
      "Missing shell metadata"
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verify CLI rejects unsupported verification tier", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await assertRejects(
      async () => {
        await main([tempDir, "--target=https://app.example.com", "--tier=garbage"]);
      },
      Error,
      "Invalid verification tier 'garbage'"
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verify CLI does not consult Cloudflare deployment URL for other platforms", async () => {
  const originalAppUrl = Deno.env.get("APP_URL");
  const originalProntoUrl = Deno.env.get("PRONTO_DEPLOYED_URL");
  try {
    Deno.env.delete("APP_URL");
    Deno.env.delete("PRONTO_DEPLOYED_URL");
    const tempDir = await Deno.makeTempDir();
    try {
      const cfDir = `${tempDir}/dist/cloudflare`;
      await Deno.mkdir(cfDir, { recursive: true });
      await Deno.writeTextFile(`${cfDir}/origin.txt`, "https://cf.workers.dev");

      await assertRejects(
        async () => {
          await main([tempDir, "--platform=gcp"]);
        },
        Error,
        "Target URL could not be resolved for platform 'gcp'"
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  } finally {
    if (originalAppUrl) Deno.env.set("APP_URL", originalAppUrl);
    if (originalProntoUrl) Deno.env.set("PRONTO_DEPLOYED_URL", originalProntoUrl);
  }
});

Deno.test("verify CLI propagates non-NotFound errors when reading deployment metadata", async () => {
  const originalAppUrl = Deno.env.get("APP_URL");
  const originalProntoUrl = Deno.env.get("PRONTO_DEPLOYED_URL");
  try {
    Deno.env.delete("APP_URL");
    Deno.env.delete("PRONTO_DEPLOYED_URL");
    const tempDir = await Deno.makeTempDir();
    try {
      const cfDir = `${tempDir}/dist/cloudflare`;
      // Create origin.txt as a directory to trigger an EISDIR read failure
      await Deno.mkdir(`${cfDir}/origin.txt`, { recursive: true });

      await assertRejects(
        async () => {
          await main([tempDir, "--platform=cloudflare"]);
        },
        Error
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  } finally {
    if (originalAppUrl) Deno.env.set("APP_URL", originalAppUrl);
    if (originalProntoUrl) Deno.env.set("PRONTO_DEPLOYED_URL", originalProntoUrl);
  }
});

Deno.test("verify CLI rejects custom verification modules with invalid exports", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const testsDir = `${tempDir}/tests`;
    await Deno.mkdir(testsDir, { recursive: true });
    await Deno.writeTextFile(
      `${testsDir}/verify.ts`,
      "export const myTests = [];"
    );

    const shellDir = `${tempDir}/shell`;
    await Deno.mkdir(shellDir, { recursive: true });
    await Deno.writeTextFile(
      `${shellDir}/shell.json`,
      JSON.stringify({ routes: [{ path: "/", screen: "home" }] })
    );

    await assertRejects(
      async () => {
        await main([tempDir, "--target=https://app.example.com", "--platform=k8s", "--tier=2"]);
      },
      Error,
      "must export a 'journeys' or 'airlocks' array"
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("verify CLI respects SAY_VERIFY_ARGS_TIER from environment", async () => {
  const originalTier = Deno.env.get("SAY_VERIFY_ARGS_TIER");
  try {
    Deno.env.set("SAY_VERIFY_ARGS_TIER", "unsupported");
    await assertRejects(
      async () => {
        await main(["--target=https://app.example.com", "--platform=k8s"]);
      },
      Error,
      "Invalid verification tier 'unsupported'"
    );
  } finally {
    if (originalTier !== undefined) {
      Deno.env.set("SAY_VERIFY_ARGS_TIER", originalTier);
    } else {
      Deno.env.delete("SAY_VERIFY_ARGS_TIER");
    }
  }
});
