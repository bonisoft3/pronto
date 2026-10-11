// The three A/B objects as Mermaid and D2 sources, from the same data.
const dir = new URL("./", import.meta.url).pathname;
const entities = JSON.parse(await Deno.readTextFile(dir + "golaberto-entities.json")) as Record<string, any>;
const byTable = Object.fromEntries(Object.values(entities).map((e: any) => [e.table, e]));

// Game's neighbourhood: the row and what refers to it, minus the card views.
const PICK = ["game", "team", "phase", "stadium", "referee", "goal", "comment", "match_probability", "player_game", "player"];
const shown = PICK.map((t) => byTable[t]).filter(Boolean);
const fieldsOf = (e: any) => {
  const f = e.fields as any[];
  const keep = f.filter((x) => x.pk || x.ref).concat(f.filter((x) => !x.pk && !x.ref).slice(0, 5));
  return keep.map((x) => ({ name: x.name, type: x.type, pk: !!x.pk, ref: x.ref as string | undefined }));
};
const picked = new Set(PICK);

// ---- entities: Mermaid erDiagram
let mer = "erDiagram\n";
for (const e of shown) {
  mer += `  ${e.table} {\n`;
  for (const f of fieldsOf(e)) mer += `    ${f.type.replace(/[^a-z0-9_]/gi, "_")} ${f.name} ${f.pk ? "PK" : f.ref ? "FK" : ""}\n`;
  mer += "  }\n";
}
for (const e of shown) for (const f of fieldsOf(e)) if (f.ref && picked.has(f.ref)) mer += `  ${e.table} }o--|| ${f.ref} : "${f.name}"\n`;
await Deno.writeTextFile(dir + "entities.mmd", mer);

// ---- entities: D2 sql_table
let d2 = "direction: right\n";
for (const e of shown) {
  d2 += `${e.table}: {\n  shape: sql_table\n`;
  for (const f of fieldsOf(e)) d2 += `  "${f.name}": ${f.type}${f.pk ? " {constraint: primary_key}" : f.ref ? " {constraint: foreign_key}" : ""}\n`;
  d2 += `}\n`;
}
for (const e of shown) for (const f of fieldsOf(e)) if (f.ref && picked.has(f.ref)) d2 += `${e.table}."${f.name}" -> ${f.ref}."id"\n`;
await Deno.writeTextFile(dir + "entities.d2", d2);

// ---- the payment machine (the effects fixture)
const payment = {
  initial: "pending",
  states: {
    pending: { on: { pay: "charging" } },
    charging: { invoke: { src: "charge", onDone: "settled", onError: "failed" } },
    settled: { type: "final" },
    failed: { on: { retry: "pending" } },
  },
};
// ---- the chess metronome
const beat = { initial: "on", states: { on: { after: { "1000": { assign: { n: "bump" }, target: "on" } } } } };

type Chart = { initial: string; states: Record<string, any> };
function mermaidState(c: Chart, title: string): string {
  let s = `stateDiagram-v2\n  [*] --> ${c.initial}\n`;
  for (const [name, st] of Object.entries(c.states)) {
    for (const [ev, t] of Object.entries(st.on ?? {})) s += `  ${name} --> ${typeof t === "string" ? t : (t as any).target} : ${ev}\n`;
    for (const [ms, t] of Object.entries(st.after ?? {})) s += `  ${name} --> ${(t as any).target} : after ${ms} ms${(t as any).assign ? " / " + Object.entries((t as any).assign).map(([k, v]) => `${k} = ${v}`).join(", ") : ""}\n`;
    if (st.invoke) {
      s += `  state "${name} · invoke ${st.invoke.src}" as ${name}\n`;
      s += `  ${name} --> ${st.invoke.onDone} : onDone\n  ${name} --> ${st.invoke.onError} : onError\n`;
    }
    if (st.type === "final") s += `  ${name} --> [*]\n`;
  }
  return s;
}
function d2State(c: Chart): string {
  let s = "direction: right\nstart: {shape: circle; style.fill: black; label: \"\"}\n";
  s += `start -> ${c.initial}\n`;
  for (const [name, st] of Object.entries(c.states)) {
    if (st.invoke) s += `${name}: {label: "${name}\\ninvoke ${st.invoke.src}"; style.stroke-dash: 3}\n`;
    else if (st.type === "final") s += `${name}: {shape: circle; style.double-border: true}\n`;
    for (const [ev, t] of Object.entries(st.on ?? {})) s += `${name} -> ${typeof t === "string" ? t : (t as any).target}: ${ev}\n`;
    for (const [ms, t] of Object.entries(st.after ?? {})) s += `${name} -> ${(t as any).target}: "after ${ms} ms${(t as any).assign ? " / " + Object.entries((t as any).assign).map(([k, v]) => `${k} = ${v}`).join(", ") : ""}"\n`;
    if (st.invoke) s += `${name} -> ${st.invoke.onDone}: onDone\n${name} -> ${st.invoke.onError}: onError\n`;
  }
  return s;
}
await Deno.writeTextFile(dir + "payment.mmd", mermaidState(payment, "PaymentMachine"));
await Deno.writeTextFile(dir + "payment.d2", d2State(payment));
await Deno.writeTextFile(dir + "beat.mmd", mermaidState(beat, "beat"));
await Deno.writeTextFile(dir + "beat.d2", d2State(beat));
console.log("sources written:", shown.map((e) => e.table).join(", "));
