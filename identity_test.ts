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
