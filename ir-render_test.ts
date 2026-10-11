// The entity card the compiler draws into ir.html: where it goes, that a redraw
// replaces it and only it, what it says, and the chart it draws.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cardHtml, chartD2, fillRegions, irRegions, type Program } from "./ir-render.ts";

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
          { name: "created_by", type: "uuid", ref: "app_user", required: false },
        ],
        access: { scope: "public", write: true },
        validations: { "one-round": { note: "a round is played once" } },
        indexes: [{ on: "team_id" }],
      },
      Team: { ir: "Team", table: "team", durability: "server", level: "replicated", fields: [{ name: "id", type: "uuid", pk: true }, { name: "game_id", type: "uuid", ref: "game" }] },
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
    effects: { charge: { ir: "charge", sink: { origin: "https://api.acquirer.example", idempotent: false }, reentry: "reconcile" } },
  },
  surface: { screens: { board: { forms: [{ entity: "Game" }] } } },
  capabilities: {},
};

Deno.test("the card says property: value on every chip, names every field upfront, links referrers and references, and draws the machine with its kinds", async () => {
  const drawn: string[] = [];
  const html = await cardHtml("Game", program.state.entities.Game, {
    program,
    charts: new Map([["game", [{ field: "flipped", initial: "no", states: { no: { on: { click: "yes" } }, yes: { on: { click: "no" } } }, writes: ["game"] }]]]),
    readMode: new Map([["Game", "eager"]]),
    d2: (src) => {
      drawn.push(src);
      return Promise.resolve("<svg/>");
    },
  });
  for (const chip of ["<b>durability</b> live", "<b>access</b> public · write true", "<b>id</b> 0xa5f5609cc8def322", "<b>level</b> compensable", "<b>delivery</b> exactly-once", "<b>writers</b> forms · Game · GameMachine", "<b>read</b> eager", "<b>roles</b> anon · app_user · service", "<b>ir</b> required"]) {
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
  assertStringIncludes(html, "not idempotent · re-entry &quot;reconcile&quot;");
  assertEquals(drawn.length, 2);
});

Deno.test("a chart's D2 draws every arrow by its event, an invoking state dashed, a final state as a ring", () => {
  const d2 = chartD2(program.state.machines!.GameMachine);
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
