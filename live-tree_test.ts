import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
import { prepareLiveTree } from "./live-tree.ts";
import { developmentCompose, sourceSyncRules } from "./launch-watch.ts";

Deno.test("development compose uses Bayt HMR without bind mounts or changing release configuration", () => {
  const source = {
    services: {
      "app-caddy": {
        build: { context: "." },
        image: "release",
        environment: { ORIGIN: "https://localhost" },
      },
      "app-render": {
        build: { additional_contexts: { door: "service:app-caddy" } },
        environment: { ENTRY: "/render/entry.html" },
      },
    },
  };
  const presentation = {
    dockerfile: "FROM caddy:pinned AS caddy",
    caddyfile: "docker/Caddyfile",
    caddy: {
      watch: [{
        action: "sync",
        path: "../.pronto/live/readiness",
        target: "/pronto/.pronto/live/readiness",
      }],
    },
    render: {
      watch: [{
        action: "sync",
        path: "../shell/index.html",
        target: "/render/shell/index.html",
      }],
    },
  };
  const dev = developmentCompose(source, "app", "/app", presentation, false);
  assertEquals(source.services["app-caddy"].build, { context: "." });
  assertEquals(dev.services["app-caddy"].build, {
    context: "/app",
    dockerfile_inline: presentation.dockerfile,
    target: "caddy",
  });
  assertEquals(dev.services["app-caddy"].image, "release-presentation");
  assertEquals(dev.services["app-caddy"].volumes, undefined);
  assertEquals(dev.services["app-render"].volumes, undefined);
  assertEquals(dev.services["app-caddy"].develop, {
    watch: [{
      action: "sync",
      path: "/app/.pronto/live/readiness",
      target: "/pronto/.pronto/live/readiness",
    }],
  });
  assertEquals(
    dev.services["app-render"].environment?.ENTRY,
    "/render/shell/index.html",
  );
  assertEquals(
    dev.services["app-render"].environment?.PRONTO_PRESENTATION_WATCH,
    "1",
  );
});

Deno.test("Compose preparation replaces stale links and removes obsolete targets", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = `${root}/authored.html`;
    const live = `${root}/live`;
    const target = `${live}/srv/screen.html`;
    const sources = [{ source, target: "/srv/screen.html" }];
    await Deno.writeTextFile(source, "before");
    await Deno.mkdir(`${live}/srv`, { recursive: true });
    await Deno.symlink(source, target);
    await Deno.writeTextFile(`${source}.tmp`, "after");
    await Deno.rename(`${source}.tmp`, source);
    assertEquals(await Deno.readTextFile(target), "after");
    assertEquals((await Deno.lstat(target)).isSymlink, true);
    await prepareLiveTree(live, sources);
    assertEquals((await Deno.lstat(target)).isSymlink, false);
    assertEquals(await Deno.readTextFile(target), "after");
    await prepareLiveTree(live, []);
    await assertRejects(() => Deno.stat(target), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Compose synchronizes authored sources directly to served paths", () => {
  const dev = developmentCompose(
    { services: { "app-caddy": {} } },
    "app",
    "/app",
    {
      dockerfile: "FROM caddy:pinned AS caddy",
      caddyfile: "docker/Caddyfile",
      caddy: { watch: [] },
      render: { watch: [] },
    },
    false,
    [{
      source: "/app/screens/card.html",
      target: "/srv/shell/screens/card.html",
    }],
  );
  assertEquals(dev.services["app-caddy"].develop, {
    watch: [{
      action: "sync",
      path: "/app/screens",
      target: "/pronto/.pronto/live/srv/shell/screens",
      initial_sync: true,
      include: ["card.html"],
      ignore: ["**", "!card.html"],
    }],
  });
  assertEquals(
    dev.services["app-caddy"].environment?.PRONTO_FILE_MODE,
    "development",
  );
  assertEquals(dev.services["app-caddy"].volumes, undefined);
});

Deno.test("directory sync groups preserve aliases and restrict initial sync to declared files", () => {
  assertEquals(
    sourceSyncRules([
      { source: "/app/screens/b.html", target: "/srv/shell/screens/b.html" },
      { source: "/app/screens/a.html", target: "/srv/shell/screens/a.html" },
      { source: "/app/screens/a.html", target: "/srv/shell/screens/a.html" },
      { source: "/app/screens/config.json", target: "/srv/shell/renamed.json" },
      {
        source: "/app/screens/x[1].html",
        target: "/srv/shell/screens/x[1].html",
      },
    ]),
    [
      {
        action: "sync",
        path: "/app/screens",
        target: "/pronto/.pronto/live/srv/shell/screens",
        initial_sync: true,
        include: ["a.html", "b.html"],
        ignore: ["**", "!a.html", "!b.html"],
      },
      {
        action: "sync",
        path: "/app/screens/config.json",
        target: "/pronto/.pronto/live/srv/shell/renamed.json",
        initial_sync: true,
      },
      {
        action: "sync",
        path: "/app/screens/x[1].html",
        target: "/pronto/.pronto/live/srv/shell/screens/x[1].html",
        initial_sync: true,
      },
    ],
  );
});
