// The entity card the compiler draws into ir.html: where it goes, that a redraw
// replaces it and only it, what it says, and the chart it draws.
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.11";
import { authoredNotes, cardHtml, chartD2, type Effect, fillNeighbourhoodRegions, fillRegions, irRegions, mergeNeighbourhoods, neighbourhoodD2, type Program, renderIr, screenNeighbourhood } from "./ir-render.ts";

const IR = `<!doctype html><html><head><title>x</title></head><body>
<section id="Game" data-kind="entity" data-durability="device">
<h3>Game — device</h3>
<p>the author's prose</p>
</section>
<section id="Tick" data-kind="entity" data-durability="tab">
<p>no card asked for</p>
</section>
</body></html>`;

Deno.test("a card is placed right after the entity's opening tag and replaced, never duplicated, on a redraw", () => {
  const once = fillRegions(IR, new Map([["Game", "<div>card 1</div>"]]));
  // After the heading that opens the element, so the author's title stays first.
  assertStringIncludes(once, `<h3>Game — device</h3>\n<!-- pronto:card --><div>card 1</div><!-- /pronto:card -->\n<p>the author's prose</p>`);
  assertStringIncludes(once, "<p>no card asked for</p>");
  const twice = fillRegions(once, new Map([["Game", "<div>card 2</div>"]]));
  assertEquals(twice.split("pronto:card").length, 3);
  assertStringIncludes(twice, "<div>card 2</div>");
  assertEquals(twice.includes("card 1"), false);
  // The prose is where the author left it, and the regions read back.
  assertStringIncludes(twice, "<p>the author's prose</p>");
  assertEquals([...irRegions(twice).entries()], [["Game", "<div>card 2</div>"]]);
  assertEquals(fillRegions(twice, new Map([["Game", "<div>card 2</div>"]])), twice);
});

Deno.test("screen and app neighbourhood regions replace and disappear without moving authored prose", () => {
  const ir = `<main><p>application prose</p><section id="board" data-kind="screen"><h2>Board</h2><p>board prose</p></section><section id="empty" data-kind="screen"><p>empty prose</p></section></main>`;
  const once = fillNeighbourhoodRegions(ir, new Map([["board", "<figure>first</figure>"]]), "<details>app</details>");
  assertStringIncludes(once, `<p>application prose</p><!-- pronto:app-neighbourhood --><details>app</details><!-- /pronto:app-neighbourhood -->\n<section id="board"`);
  assertStringIncludes(once, `<h2>Board</h2>\n<!-- pronto:neighbourhood --><figure>first</figure><!-- /pronto:neighbourhood --><p>board prose</p>`);
  const twice = fillNeighbourhoodRegions(once, new Map([["board", "<figure>second</figure>"]]), "<details>app two</details>");
  assertEquals(twice.split("pronto:neighbourhood").length - 1, 2);
  assertEquals(twice.includes("first"), false);
  assertStringIncludes(twice, "board prose");
  assertStringIncludes(twice, "application prose");
  assertEquals(fillNeighbourhoodRegions(twice, new Map(), null).replaceAll("\n", ""), ir.replaceAll("\n", ""));
});

const program: Program = {
  state: {
    entities: {
      Game: {
        ir: "Game",
        id: "0xa5f5609cc8def322",
        table: "game",
        durability: "live",
        level: "compensable",
        fields: [
          { ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()" },
          { ordinal: 2, name: "status", type: "string", default: "'pending'" },
          { ordinal: 3, name: "team_id", type: "uuid", ref: "team" },
          { ordinal: 4, name: "round", type: "int32", required: false, cel: "this >= 1" },
          { ordinal: 5, name: "score", type: "int32", retired: true, required: false },
          { ordinal: 6, name: "parent_id", type: "uuid", ref: "game", required: false },
          { name: "created_by", type: "uuid", ref: "app_user", required: false },
        ],
        access: { scope: "public", write: true },
        validations: { "one-round": { note: "a round is played once" } },
        indexes: [{ on: "team_id" }],
        writers: [{ by: "board", kind: "form", ops: ["create", "update"] }, { by: "Game-flipped", kind: "chart", ops: ["update"] }, { by: "GameMachine", kind: "machine", ops: ["update"] }],
      },
      Team: { ir: "Team", table: "team", durability: "server", level: "replicated", fields: [{ name: "id", type: "uuid", pk: true }, { name: "game_id", type: "uuid", ref: "game" }], writers: [] },
      Tick: { ir: "Tick", table: "tick", durability: "tab", level: "local", fields: [{ name: "id", type: "uuid", pk: true }], writers: [] },
      Quoted: { ir: 'Quoted "Thing"', table: "quoted thing", durability: "device", level: "local", fields: [{ name: "id", type: "uuid", pk: true }, { name: 'game "id"', type: "uuid", ref: "game" }], writers: [] },
    },
    machines: {
      GameMachine: {
        ir: "GameMachine",
        entity: "Game",
        field: "status",
        initial: "pending",
        level: "external",
        states: { pending: { on: { pay: "charging" } }, charging: { invoke: { src: "charge", onDone: "settled", onError: "failed" } }, settled: { type: "final" }, failed: { on: { retry: "pending" } } },
      },
    },
    effects: { charge: { ir: "charge", sink: { origin: "https://api.acquirer.example", idempotent: false }, reentry: "reconcile", note: "the acquirer answers a charge by key" } },
  },
  surface: { screens: { routeName: { ir: "board", title: "Board", reads: [{ table: "game" }] }, empty: { ir: "empty", title: "Empty", reads: [] } } },
  capabilities: {},
};

Deno.test("a neighbourhood contains only a screen's deduplicated reads, with related fields and no outside edge", () => {
  const graph = screenNeighbourhood(program, "routeName", { ir: "board", title: "Board", reads: [{ table: "game" }, { table: "game" }] }, new Map([["Game", new Set(["status"])]]));
  assertEquals(graph.entities, ["Game"]);
  const source = neighbourhoodD2(program, graph, new Set(["Game"]));
  assertStringIncludes(source, '"Game": {\n  shape: sql_table\n  link: "#Game"');
  assertStringIncludes(source, '"id": "uuid" {constraint: primary_key}');
  assertStringIncludes(source, '"team_id": "uuid" {constraint: foreign_key}');
  assertStringIncludes(source, '"status": "string" {constraint: machine}');
  assertStringIncludes(source, '"Game"."parent_id" -> "Game"."id"');
  assertEquals(source.includes('"Game"."team_id" -> "Team"."id"'), false);
  assertEquals(source.includes('"Team": {'), false);
  assertEquals(source.includes("created_by"), false);
  assertEquals(source.includes("score"), false);
});

Deno.test("embeds resolve declared tables and foreign-key fields, quote names, and reject ambiguous or unknown reads", () => {
  const graph = screenNeighbourhood(program, "related", { ir: "related", title: "Related", reads: [{ table: "game", embeds: ["team_id", "quoted thing"] }] }, new Map());
  assertEquals(graph.entities, ["Game", "Quoted", "Team"]);
  const source = neighbourhoodD2(program, graph, new Set(["Game", 'Quoted "Thing"']));
  assertStringIncludes(source, '"Quoted \\"Thing\\"": {');
  assertStringIncludes(source, 'link: "#Quoted \\"Thing\\""');
  assertStringIncludes(source, '"Game"."team_id" -> "Team"."id"');
  assertThrows(() => screenNeighbourhood(program, "broken", { ir: "broken", title: "Broken", reads: [{ table: "missing" }] }, new Map()), Error, "screen broken reads missing, the table of no declared entity");
  assertThrows(() => screenNeighbourhood(program, "broken", { ir: "broken", title: "Broken", reads: [{ table: "game", embeds: ["typo"] }] }, new Map()), Error, "screen broken read game has unresolved embed typo");
  const ambiguous: Program = { ...program, state: { ...program.state, entities: { ...program.state.entities,
    Other: { ir: "Other", table: "other", durability: "device", level: "local", fields: [{ name: "id", type: "uuid", pk: true }, { name: "team_id", type: "uuid", ref: "quoted thing" }], writers: [] },
  } } };
  assertThrows(() => screenNeighbourhood(ambiguous, "broken", { ir: "broken", title: "Broken", reads: [{ table: "game", embeds: ["other", "team_id"] }] }, new Map()), Error, "screen broken embed team_id names more than one declared entity: Quoted, Team");
});

Deno.test("the app graph unions screen edges without inducing a relationship between separately read entities", () => {
  const game = screenNeighbourhood(program, "game", { ir: "game", title: "Game", reads: [{ table: "game" }] }, new Map());
  const team = screenNeighbourhood(program, "team", { ir: "team", title: "Team", reads: [{ table: "team" }] }, new Map());
  const source = neighbourhoodD2(program, mergeNeighbourhoods([game, team]), new Set());
  assertEquals(source.includes('"Game"."team_id" -> "Team"."id"'), false);
  assertEquals(source.includes('"Team"."game_id" -> "Game"."id"'), false);
  assertStringIncludes(source, '"Game"."parent_id" -> "Game"."id"');
});

Deno.test("the card says property: value on every chip, names every field upfront, links referrers and references, and draws the machine with its kinds", async () => {
  const drawn: string[] = [];
  const html = await cardHtml("Game", program.state.entities.Game, {
    program,
    charts: new Map([["game", [{ field: "flipped", initial: "no", states: { no: { on: { click: "yes" } }, yes: { on: { click: "no" } } }, writes: ["game"], screens: ["board"], suffix: "" }]]]),
    readMode: new Map([["Game", "eager"]]),
    d2: (src) => {
      drawn.push(src);
      return Promise.resolve('<svg viewBox="0 0 400 900"><svg width="400" height="900"></svg></svg>');
    },
  });
  for (const chip of ["<b>durability</b> live", "<b>access</b> public · write true", "<b>id</b> 0xa5f5609cc8def322", "<b>level</b> compensable", "<b>delivery</b> exactly-once", "<b>writers</b> form:board create·update, chart:Game-flipped update, machine:GameMachine update", "<b>read</b> eager", "<b>roles</b> anon · app_user · service", "<b>ir</b> required"]) {
    assertStringIncludes(html, chip);
  }
  // Every chip explains itself; the level's sentence names its rung.
  assertStringIncludes(html, 'data-tip="2 of 5');
  // Stamps are the platform's, off the name line; the machine's field is marked.
  assertStringIncludes(html, '<span class="fname">status<i class="m mach">⚙</i></span>');
  assertEquals(html.includes('<span class="fname">created_by'), false);
  // A retired field is a tombstone: off the name line, in the table with its ordinal kept.
  assertEquals(html.includes('<span class="fname">score'), false);
  assertStringIncludes(html, '<tr class="retired"><td class="o">5</td><td class="k">score</td>');
  assertStringIncludes(html, '<td class="o">1</td><td class="k">id</td>');
  assertStringIncludes(html, '<a class="rel in" href="#Team">team<span class="col">.game_id</span></a>');
  assertStringIncludes(html, '<a class="rel out" href="#Team">team<span class="col"> via team_id</span></a>');
  assertStringIncludes(html, "<code>one-round</code> <span class=\"note\">a round is played once</span>");
  // Two machines: the terminal's chart and the mecha machine, each an element of its kind.
  assertStringIncludes(html, 'data-kind="machine" id="Game-flipped" data-of="Game"');
  assertStringIncludes(html, 'data-kind="machine" id="GameMachine" data-of="Game"');
  assertStringIncludes(html, 'data-kind="effect" id="charge" data-of="GameMachine"');
  assertStringIncludes(html, 'not idempotent · re-entry reconcile · <span class="note">the acquirer answers a charge by key</span>');
  assertEquals(drawn.length, 2);
});

Deno.test("the card carries the authored table's notes, so the table, hop 2's input, stays in ir.html collapsed under it", async () => {
  const section = `<h3>Game</h3><p>prose</p><table data-extract="fields">
<tr><th>field</th><th>type</th><th>constraint</th><th>notes</th></tr>
<tr><td>id</td><td>text</td><td></td><td>primary <code>key</code></td></tr>
<tr><td>status</td><td>text</td><td></td><td></td></tr>
</table>`;
  const notes = authoredNotes(section);
  assertEquals([...notes], [["id", "primary <code>key</code>"]]);
  assertEquals(authoredNotes("<p>no table</p>").size, 0);
  const ctx = { program, charts: new Map(), readMode: new Map([["Game", "eager"]]), d2: () => Promise.resolve("<svg></svg>") };
  const html = await cardHtml("Game", program.state.entities.Game, ctx, notes);
  assertStringIncludes(html, '<td class="n">primary <code>key</code></td>');
  assertStringIncludes(html, '<details class="more authored"><summary>the authored table</summary></details>');
  // The raw entity is one collapsible tree, scalars as JSON literals.
  assertStringIncludes(html, '<div class="jl"><span class="jk">durability</span>: <span class="jv">&quot;live&quot;</span></div>');
  assertStringIncludes(html, '<details class="jn"><summary><span class="jk">fields</span> <span class="jv">[');
  // Without notes the table keeps its five columns.
  assertEquals((await cardHtml("Game", program.state.entities.Game, ctx)).includes('class="n"'), false);
});

Deno.test("the derived line names the units handed an entity's row, and the unit whose memo an entity is", async () => {
  const vendored = {
    ...program,
    capabilities: {
      vendored: {
        stockfish: { isolation: "agent", ports: { reads: ["Game"], raises: ["answer"] }, memo: { entity: "Tick", key: ["fen", "nodes"] } },
        embed: { isolation: "realm", ports: { reads: ["Game"], raises: [] } },
      },
    },
  };
  const ctx = { program: vendored, charts: new Map(), readMode: new Map([["Game", "eager"], ["Team", "eager"]]), d2: () => Promise.resolve("<svg/>") };
  const game = await cardHtml("Game", vendored.state.entities.Game, ctx);
  assertStringIncludes(game, "<b>read by</b> stockfish (agent), embed (realm)");
  assertEquals(game.includes("<b>memo of</b>"), false);
  const tick = await cardHtml("Tick", vendored.state.entities.Tick, ctx);
  assertStringIncludes(tick, "<b>memo of</b> stockfish by fen · nodes");
  assertEquals(tick.includes("<b>read by</b>"), false);
  // An app with no unit says nothing: the chips are a fact, not a slot.
  const bare = await cardHtml("Game", program.state.entities.Game, { ...ctx, program });
  assertEquals(bare.includes("<b>read by</b>"), false);
});

Deno.test("the read chip is the read_mode fact row: a browser tier has none and prints —, a server entity without its row is a refusal, not a guess", async () => {
  const ctx = { program, charts: new Map(), readMode: new Map([["Game", "eager"]]), d2: () => Promise.resolve("<svg/>") };
  // read.cue derives a mode only `if e.server`; the card must not invent one for a tab table.
  assertStringIncludes(await cardHtml("Tick", program.state.entities.Tick, ctx), "<b>read</b> —");
  await assertRejects(() => cardHtml("Team", program.state.entities.Team, ctx), Error, "Team is a server entity with no read_mode fact row");
});

Deno.test("an effect that is not idempotent and states no reentry is a refusal, not a guess", async () => {
  // The schema pairs `reentry` with `idempotent: false`; the card reprints that pairing and defaults nothing.
  const bare = { ...program, state: { ...program.state, effects: { charge: { ir: "charge", sink: { origin: "https://api.acquirer.example", idempotent: false }, note: "n" } } } } as Program;
  const ctx = { program: bare, charts: new Map(), readMode: new Map([["Game", "eager"]]), d2: () => Promise.resolve("<svg/>") };
  await assertRejects(() => cardHtml("Game", bare.state.entities.Game, ctx), Error, "effect charge is not idempotent and states no reentry");
});

// The record's delivery table: level 4 with idempotent or reconcile is
// exactly-once, with unknown at-most-once, with repeat at-least-once; the
// entity's chip is its pivot's word and the machine's panel carries its own.
Deno.test("delivery follows the sink: the card's chip and the machine's panel say what the effect's re-entry admits", async () => {
  const withEffect = (charge: Effect) => ({ ...program, state: { ...program.state, effects: { charge } } } as Program);
  const ctx = (p: Program) => ({ program: p, charts: new Map(), readMode: new Map([["Game", "eager"]]), d2: () => Promise.resolve("<svg/>") });
  const base = { ir: "charge", sink: { origin: "https://api.acquirer.example", idempotent: false }, note: "n" };
  for (const [reentry, word] of [["reconcile", "exactly-once"], ["unknown", "at-most-once"], ["repeat", "at-least-once"]] as const) {
    const p = withEffect({ ...base, reentry });
    const html = await cardHtml("Game", p.state.entities.Game, ctx(p));
    // Once in the header, once on the machine's title line.
    assertEquals(html.split(`<b>delivery</b> ${word}`).length - 1, 2, reentry);
    assertStringIncludes(html, `<b>level</b> external</span><span class="chip derived"`);
  }
  const idempotent = withEffect({ ...base, sink: { ...base.sink, idempotent: true } });
  assertStringIncludes(await cardHtml("Game", idempotent.state.entities.Game, ctx(idempotent)), "<b>delivery</b> exactly-once");
  // A machine below the pivot takes its level's word: Team's replicated machine-less row is exactly-once.
  assertStringIncludes(await cardHtml("Team", program.state.entities.Team, { ...ctx(program), readMode: new Map([["Team", "lazy"]]) }), "<b>delivery</b> exactly-once");
});

Deno.test("a chart's D2 draws every arrow by its event, an invoking state dashed, a final state as a ring", () => {
  const machine = program.state.machines!.GameMachine;
  const d2 = chartD2({ initial: machine.initial!, states: machine.states! });
  assertStringIncludes(d2, '"charging": {label: "charging\\ninvoke charge"; style.stroke-dash: 3}');
  assertStringIncludes(d2, '"settled": {shape: circle; style.double-border: true}');
  assertStringIncludes(d2, '"pending" -> "charging": "pay"');
  assertStringIncludes(d2, '"charging" -> "settled": onDone');
  assertStringIncludes(d2, '"failed" -> "pending": "retry"');
  const timer = chartD2({ initial: "on", states: { on: { after: { "1000": { assign: { n: "bump" }, target: "on" } } } } });
  assertStringIncludes(timer, '"on" -> "on": "after 1000 ms / n = bump"');
  // A root-level transition fires in every state: one arrow from "any".
  const selector = chartD2({ initial: "house", on: { "click@mode-trigger-house": [{ guard: { type: "seated" }, target: "house" }], "click@mode-trigger-hotseat": [{ guard: { type: "seated" }, target: "hotseat" }] }, states: { house: {}, hotseat: {} } });
  assertStringIncludes(selector, 'any -> "house": "click@mode-trigger-house"');
  assertStringIncludes(selector, 'any -> "hotseat": "click@mode-trigger-hotseat"');
  // A boolean field's states are D2 keywords; quoted, they compile.
  const flag = chartD2({ initial: "false", states: { false: { on: { click: "true" } }, true: { on: { click: "false" } } } });
  assertStringIncludes(flag, 'start -> "false"');
  assertStringIncludes(flag, '"false" -> "true": "click"');
});

Deno.test("renderIr uses screen ir aliases, ignores collection-only fact reach, memoizes SVGs, and removes empty graphs", async () => {
  const appDir = await Deno.makeTempDir();
  try {
    const ir = `<!doctype html><html><head></head><body>
<section id="Game" data-kind="entity"><h2>Game</h2><p>entity prose</p></section>
<section id="board" data-kind="screen"><h2>Board</h2><p>board prose</p></section>
<section id="empty" data-kind="screen"><h2>Empty</h2><p>empty prose</p></section>
</body></html>`;
    await Deno.writeTextFile(`${appDir}/ir.html`, ir);
    const renderedProgram: Program = {
      state: { entities: { Game: program.state.entities.Game, Team: program.state.entities.Team, Tick: program.state.entities.Tick } },
      surface: { screens: {
        routeName: { ir: "board", title: "Board", reads: [{ table: "game" }, { table: "tick" }, { table: "game" }] },
        emptyRoute: { ir: "empty", title: "Empty", reads: [] },
      } },
      capabilities: {},
    };
    const facts = {
      read_mode: [{ entity: "Game", mode: "eager" }],
      // Collection reach includes write-only Team; it must not become a read neighbourhood member.
      reads: [{ screen: "routeName", entity: "Game" }, { screen: "routeName", entity: "Tick" }, { screen: "routeName", entity: "Team" }],
    };
    const drawn: string[] = [];
    const d2 = (source: string) => {
      drawn.push(source);
      return Promise.resolve('<svg viewBox="0 0 400 900"><svg width="400" height="900"></svg></svg>');
    };
    await assertRejects(() => renderIr(appDir, "ir.html", renderedProgram, { ...facts, reads: [{ screen: "routeName", entity: "Missing" }] }, d2), Error, "read fact names undeclared entity Missing");
    assertEquals(await renderIr(appDir, "ir.html", renderedProgram, facts, d2), true);
    const once = await Deno.readTextFile(`${appDir}/ir.html`);
    assertEquals(drawn.length, 1);
    // The picture lives beside ir.html, so a reader of the document pays for the prose and not the drawing.
    assertStringIncludes(await Deno.readTextFile(`${appDir}/ir/neighbourhood-board.svg`), '<svg viewBox="0 0 400 900" width="400" height="900"><svg width="400" height="900">');
    assertStringIncludes(once, '<img src="ir/neighbourhood-board.svg" width="400" height="900" alt="Board entity diagram">');
    assertStringIncludes(once, '<img src="ir/neighbourhood-app.svg" width="400" height="900" alt="App entity diagram">');
    assertEquals(once.includes("<svg"), false);
    assertStringIncludes(drawn[0], '"Game": {');
    assertStringIncludes(drawn[0], 'link: "#Game"');
    assertStringIncludes(drawn[0], '"Tick": {');
    assertEquals(drawn[0].includes('link: "#Tick"'), false);
    assertEquals(drawn[0].includes('"Team": {'), false);
    assertStringIncludes(once, 'role="region" tabindex="0" aria-label="Board entity diagram"');
    assertStringIncludes(once, 'role="region" tabindex="0" aria-label="App entity diagram"');
    assertStringIncludes(once, '<figcaption><b>entities:</b> <a href="#Game">Game</a>, <span>Tick</span></figcaption>');
    assertEquals(once.indexOf("pronto:app-neighbourhood") < once.indexOf('<section id="board"'), true);
    assertEquals(once.includes('id="empty" data-kind="screen"><h2>Empty</h2>\n<!-- pronto:neighbourhood -->'), false);
    assertEquals(await renderIr(appDir, "ir.html", renderedProgram, facts, d2), false);
    assertEquals(drawn.length, 2);

    const emptyProgram: Program = {
      ...renderedProgram,
      surface: { screens: { routeName: { ir: "board", title: "Board", reads: [] }, emptyRoute: renderedProgram.surface.screens.emptyRoute } },
    };
    assertEquals(await renderIr(appDir, "ir.html", emptyProgram, facts, d2), true);
    const empty = await Deno.readTextFile(`${appDir}/ir.html`);
    assertEquals(empty.includes("pronto:neighbourhood"), false);
    assertEquals(empty.includes("pronto:app-neighbourhood"), false);
    assertEquals((await Array.fromAsync(Deno.readDir(`${appDir}/ir`))).map((e) => e.name).filter((n) => n.endsWith(".svg")), []);
    assertStringIncludes(empty, "entity prose");
    assertStringIncludes(empty, "board prose");
    assertStringIncludes(empty, "empty prose");
  } finally {
    await Deno.remove(appDir, { recursive: true });
  }
});

Deno.test("one entity field cannot hide a divergent chart from another screen", async () => {
  const appDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${appDir}/ir.html`, IR);
    const p: Program = { ...program, surface: { screens: {
      alpha: { ir: "alpha", title: "Alpha", reads: [] },
      beta: { ir: "beta", title: "Beta", reads: [] },
    } } };
    const machine = { field: "phase", initial: "idle", states: { idle: { on: { go: "done" } }, done: {} } };
    const row = { screen: "alpha", table: "game", field: "phase", machine: JSON.stringify(machine) };
    let draws = 0;
    const draw = () => { draws++; return Promise.resolve("<svg/>"); };
    // JSON property order does not create a second machine identity.
    await renderIr(appDir, "ir.html", p, { read_mode: [{ entity: "Game", mode: "eager" }], chart: [row, { ...row, screen: "beta", machine: JSON.stringify({ states: machine.states, initial: "idle", field: "phase" }) }] }, draw);
    assertEquals(draws, 2); // The terminal chart and Game's mecha machine.
    const divergent = { ...row, screen: "beta", machine: JSON.stringify({ ...machine, initial: "cold", states: { cold: { on: { heat: "hot" } }, hot: {} } }) };
    for (const screen of ["alpha", "beta"]) {
      const sources: string[] = [];
      await renderIr(appDir, "ir.html", p, { read_mode: [{ entity: "Game", mode: "eager" }], chart: [row, { ...divergent, screen }] }, (source) => {
        sources.push(source);
        return Promise.resolve("<svg/>");
      });
      const html = await Deno.readTextFile(`${appDir}/ir.html`);
      assertStringIncludes(html, 'id="Game-phase-1"');
      assertStringIncludes(html, 'id="Game-phase-2"');
      assertStringIncludes(html, "Game · phase · alpha (1)");
      assertStringIncludes(html, `Game · phase · ${screen} (2)`);
      assertEquals(sources.length, 3);
      assertEquals(sources.some((source) => source.includes('"idle" -> "done": "go"')), true);
      assertEquals(sources.some((source) => source.includes('"cold" -> "hot": "heat"')), true);
    }
  } finally {
    await Deno.remove(appDir, { recursive: true });
  }
});

Deno.test("a screen's host-DOM authority is visible even without entity reads", async () => {
  const appDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${appDir}/ir.html`, '<html><head></head><body><section id="board" data-kind="screen"><h2>Board</h2></section><section id="dealer" data-kind="hatch"><h2>Dealer</h2></section></body></html>');
    const p: Program = {
      state: { entities: {} },
      surface: { screens: { board: { ir: "board", title: "Board", reads: [], hatches: ["dealer"] } } },
      capabilities: { hatches: { dealer: { ir: "dealer", kind: "host-dom", note: "full browser <authority>" } } },
    };
    const draw = () => { throw new Error("a hatch is not an entity graph"); };
    await renderIr(appDir, "ir.html", p, {}, draw);
    const html = await Deno.readTextFile(`${appDir}/ir.html`);
    assertStringIncludes(html, 'Host-DOM hatch <a href="#dealer">dealer</a>');
    assertStringIncludes(html, "unspecified");
    assertStringIncludes(html, "full browser &lt;authority&gt;");
    assertEquals(await renderIr(appDir, "ir.html", p, {}, draw), false);
    await assertRejects(() => renderIr(appDir, "ir.html", { ...p, capabilities: {} }, {}, draw), Error, "undeclared host-DOM hatch");
  } finally { await Deno.remove(appDir, { recursive: true }); }
});
