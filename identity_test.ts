import { strict as assert } from "node:assert";
import { collisions, identitiesOf, irDisagreements, lost, stampCue, stampIr } from "./identity.ts";

const row = {
  name: "Row",
  table: "row",
  id: "0xc75ee275aaa2d971",
  fields: [
    { name: "id", type: "text", ordinal: 1 },
    { name: "label", type: "text", ordinal: 2 },
  ],
};
const snapshot = identitiesOf([row]);

Deno.test("a rename keeps every identity, so nothing is lost", () => {
  const renamed = { ...row, table: "line", fields: [row.fields[0], { ...row.fields[1], name: "title" }] };
  assert.deepEqual(lost(snapshot, identitiesOf([renamed])), []);
});

Deno.test("a field that disappears is lost, and the message names the way out", () => {
  const [finding] = lost(snapshot, identitiesOf([{ ...row, fields: [row.fields[0]] }]));
  assert.deepEqual(finding.message, `row lost ordinal 2 (was "label"): mark it retired instead`);
});

// The failure identity exists to remove: one digit of an id is a different
// entity, which without a snapshot reads as an addition and nothing else.
Deno.test("a type id off by one digit is an entity gone", () => {
  const [finding] = lost(snapshot, identitiesOf([{ ...row, id: "0xc75ee275aaa2d972" }]));
  assert.deepEqual(finding.message.startsWith("entity 0xc75ee275aaa2d971"), true);
});

Deno.test("a type change and an un-retirement are both refused", () => {
  const retyped = { ...row, fields: [row.fields[0], { ...row.fields[1], type: "int" }] };
  assert.deepEqual(lost(snapshot, identitiesOf([retyped])).length, 1);
  const retired = identitiesOf([{ ...row, fields: [row.fields[0], { ...row.fields[1], retired: true }] }]);
  assert.deepEqual(lost(retired, snapshot).length, 1);
  assert.deepEqual(lost(snapshot, retired), []);
});

Deno.test("canonical type spellings do not retire an existing field", () => {
  for (const [oldType, type] of [["text", "string"], ["int", "int32"], ["bigint", "int64"], ["timestamptz", "timestamp"]]) {
    const was = identitiesOf([{ ...row, fields: [{ ...row.fields[0], type: oldType }] }]);
    const now = identitiesOf([{ ...row, fields: [{ ...row.fields[0], type }] }]);
    assert.deepEqual(lost(was, now), []);
  }
});

Deno.test("a recorded decimal profile cannot silently change", () => {
  const field = { ...row.fields[0], type: "decimal", precision: 18, scale: 6 };
  const was = identitiesOf([{ ...row, fields: [field] }]);
  const now = identitiesOf([{ ...row, fields: [{ ...field, scale: 2 }] }]);
  assert.equal(lost(was, now).length, 1);
});

Deno.test("a copied entity block collides", () => {
  assert.deepEqual(collisions([row, { ...row, name: "Copy" }]).length, 1);
});

const cue = ["\t\tRow: {", '\t\t\ttable: "row"', "\t\t\tfields: [", '\t\t\t\t{name: "id", type: "text", pk: true},', "\t\t\t\t// what it says", '\t\t\t\t{name: "label", type: "text"},', "\t\t\t]", "\t\t}"].join("\n");
const bare = { name: "Row", table: "row", fields: [{ name: "id", type: "text" }, { name: "label", type: "text" }] };

Deno.test("stamping numbers the fields in order and continues from the highest", () => {
  const once = stampCue(cue, bare, "0xc75ee275aaa2d971");
  assert.deepEqual(once.includes('{ordinal: 2, name: "label"'), true);
  assert.deepEqual(once.split("\n")[1], '\t\t\tid: "0xc75ee275aaa2d971"');
  const grown = once.replace('\t\t\t]', '\t\t\t\t{name: "hue", type: "text"},\n\t\t\t]');
  const again = stampCue(grown, { ...row, fields: [...row.fields, { name: "hue", type: "text" }] }, undefined);
  assert.deepEqual(again.includes('{ordinal: 3, name: "hue"'), true);
});

Deno.test("several fields on one line are each stamped, and a seed row that opens with name: is not", () => {
  const packed = ['\t\tRow: {', '\t\t\tfields: [', '\t\t\t\t{name: "id", type: "text"}, {name: "label", type: "text"},', '\t\t\t]', '\t\t\tseed: [{name: "label", id: "x"}]', '\t\t}'].join("\n");
  const out = stampCue(packed, bare, undefined);
  assert.deepEqual(out.includes('{ordinal: 1, name: "id", type: "text"}, {ordinal: 2, name: "label"'), true);
  assert.deepEqual(out.includes('seed: [{name: "label", id: "x"}]'), true);
});

Deno.test("space-indented entity blocks and spaced field braces are stamped", () => {
  const spaced = [
    "    Row: {",
    '        table: "row"',
    "        fields: [",
    '            { name: "id", type: "text", pk: true },',
    '            { name: "label", type: "text" },',
    "        ]",
    "    }",
  ].join("\n");
  const out = stampCue(spaced, bare, "0xc75ee275aaa2d971");
  assert.deepEqual(out.split("\n")[1], '        id: "0xc75ee275aaa2d971"');
  assert.deepEqual(out.includes('{ ordinal: 1, name: "id", type: "text", pk: true }'), true);
  assert.deepEqual(out.includes('{ ordinal: 2, name: "label", type: "text" }'), true);
});

Deno.test("mint ignores a nested fields example before the entity's own fields", () => {
  const example = [
    "        _example: {",
    "            fields: [",
    '                {name: "id"}, {name: "label"}',
    "            ]",
    "        }",
  ].join("\n");
  const source = [
    "    Row: {",
    example,
    "// Helpers are outside the entity field list.",
    '        table: "row"',
    '        fields: [{name: "id", type: "string"}, {name: "label", type: "string"}]',
    "    }",
  ].join("\n");
  const out = stampCue(source, bare, "0xc75ee275aaa2d971");
  assert.equal(out.includes(example), true);
  assert.equal(out.split("\n")[1], '        id: "0xc75ee275aaa2d971"');
  assert.equal(out.includes('fields: [{ordinal: 1, name: "id", type: "string"}, {ordinal: 2, name: "label", type: "string"}]'), true);
});

// A field mint cannot see would be skipped and leave a gap under the next one.
Deno.test("a field declared in a shape mint does not read is refused, not skipped", () => {
  const multiline = cue.replace('{name: "label", type: "text"},', '{\n\t\t\t\t\tname: "label"\n\t\t\t\t\ttype: "text"\n\t\t\t\t},');
  assert.throws(() => stampCue(multiline, bare, "0xc75ee275aaa2d971"), /not declared as a/);
});

Deno.test("the ir is stamped where it has a section and agrees afterwards", () => {
  const ir = '<section id="Row" data-kind="entity" data-durability="tab">\n<tr><td>id</td><td>text</td></tr>\n<tr><td>label</td></tr>\n</section>';
  const stamped = stampIr(ir, row);
  assert.deepEqual(irDisagreements(stamped, [row]), []);
  assert.deepEqual(irDisagreements(stamped.replace("<td>label</td>", "<td>title</td>"), [row]).length, 1);
  assert.deepEqual(stampIr(stamped, row), stamped);
});

// An app started by copying another's ir.html carries that app's type ids;
// before any snapshot exists the program's ids are the only ones recorded.
Deno.test("a fresh app's ir takes the program's type id over a copied one", () => {
  const copied = '<section id="Row" data-kind="entity" data-durability="tab" data-type-id="0x8000000000000001">\n<tr><td>id</td></tr>\n</section>';
  assert.deepEqual(irDisagreements(stampIr(copied, row), [row]).length, 1);
  assert.deepEqual(irDisagreements(stampIr(copied, row, true), [row]), []);
});
