import { assert, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles } from "./effects-fixtures.ts";
import { driveEntities, driveProgram } from "./drive-access-fixture.ts";

Deno.test("a shared entity's policies ask its role, and a group is one shape", async () => {
  const files = await emitFiles(driveProgram());
  const policies = files["services/database/migrations/006_policies.sql"].text;
  const tables = files["services/database/migrations/005_create_tables.sql"].text;
  // The role, and the two refusals a policy cannot make.
  assertStringIncludes(policies, "CREATE OR REPLACE FUNCTION company_role(row_id uuid) RETURNS text");
  assertStringIncludes(policies, "m.group_id = r.id::text || ':admins'");
  assertStringIncludes(policies, "CREATE TRIGGER company_owner_guard BEFORE UPDATE OR DELETE ON company");
  assertStringIncludes(policies, "WITH CHECK (company_role(company.id) IN ('owner', 'writer'))");
  // A composition has its parent's role, the grant table among them unless
  // the parent keeps its grants to its owner.
  assertStringIncludes(policies, "expense_type_app_user_insert ON expense_type FOR INSERT TO app_user WITH CHECK (company_role(expense_type.company_id) IN ('owner', 'writer'))");
  assertStringIncludes(policies, "company_grant_app_user_insert ON company_grant FOR INSERT TO app_user WITH CHECK (company_role(company_grant.company_id) IN ('owner', 'writer'))");
  assertStringIncludes(policies, "advance_grant_app_user_insert ON advance_grant FOR INSERT TO app_user WITH CHECK (advance_role(advance_grant.advance_id) = 'owner')");
  // Handed to another owner, the previous one is left its writer.
  assertStringIncludes(policies, "CREATE TRIGGER company_handover AFTER UPDATE ON company");
  assertStringIncludes(policies, "DELETE FROM company_grant WHERE company_id = NEW.id AND user_id IN (OLD.owner_id, NEW.owner_id);");
  assertStringIncludes(policies, "INSERT INTO company_grant (id, company_id, user_id, role) VALUES (gen_random_uuid(), NEW.id, OLD.owner_id, 'writer');");
  // A group named by a column: the column, on the table and under it, and its edge.
  assertStringIncludes(tables, `"group_finance" TEXT GENERATED ALWAYS AS ("company_id"::text || ':finance') STORED`);
  assertStringIncludes(policies, "INSERT INTO mecha.shape_key VALUES ('public.advance', 'group_finance', 'public.group_member', 'group_id')");
  assertStringIncludes(policies, "INSERT INTO mecha.shape_key VALUES ('public.advance_grant', 'group_finance', 'public.group_member', 'group_id')");
  // A grant row names a user or a group: one column each, one edge each.
  assertStringIncludes(tables, `CHECK (num_nonnulls("user_id", "group_id") = 1)`);
  assertStringIncludes(policies, "s.advance_id = r.id AND (s.user_id = auth_uid() OR EXISTS (SELECT 1 FROM group_member m WHERE m.group_id = s.group_id AND m.user_id = auth_uid())) AND s.role = 'writer')");
  assertStringIncludes(policies, "INSERT INTO mecha.shape_key VALUES ('public.advance_grant', 'user_id', 'subject', 'id')");
  assertStringIncludes(policies, "INSERT INTO mecha.shape_key VALUES ('public.advance_grant', 'group_id', 'public.group_member', 'group_id')");
  assert(!policies.includes("company_grant', 'group_id'"));
  // A grant holds one of the two roles, and the role's helper is not an RPC.
  assertStringIncludes(tables, `CHECK ("role" IN ('reader', 'writer'))`);
  assertStringIncludes(policies, "AND s.role = 'reader')");
  assertStringIncludes(policies, "REVOKE ALL ON FUNCTION advance_role(uuid) FROM PUBLIC;");
  assertStringIncludes(policies, "advance: only the owner files a row under another finance");
  // Filed only into a company the writer reads.
  assertStringIncludes(policies, "WITH CHECK (advance.owner_id = auth_uid() AND (advance.company_id IS NULL OR company_role(advance.company_id) IS NOT NULL))");
  // A composition is moved or deleted by the role that writes its parent, and
  // follows its parent into another group.
  assertStringIncludes(policies, "CREATE TRIGGER expense_type_write_guard BEFORE UPDATE OR DELETE ON expense_type");
  assertStringIncludes(policies, "CREATE TRIGGER advance_grant_regroup AFTER UPDATE ON advance");
  // And into another owner's scope, when its parent is handed over.
  assertStringIncludes(policies, "CREATE TRIGGER expense_type_rescope AFTER UPDATE ON company");
  // The membership list is floored by its member, and no policy admits a write.
  assertStringIncludes(tables, `"scope_id" TEXT GENERATED ALWAYS AS ('user:' || "user_id") STORED NOT NULL`);
  assertStringIncludes(policies, "CALL rls_protect('group_member');");
  assert(!/group_member_app_user_(insert|update|delete|all)/.test(policies));
});

Deno.test("a group grant with no membership list, or an unknown column, is refused by name", async () => {
  const without = driveEntities.slice(driveEntities.indexOf("      Company: {"));
  await assertRejects(() => emitFiles(driveProgram(without)), Error, "shared with a group, and no entity is the membership list");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`of: "company_id"`, `of: "firm_id"`))), Error, "group finance is of firm_id, which is no field of it");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{group: "finance", of: "company_id", role: "reader"}`, `{group: "admins", role: "reader"}`))), Error, "group admins: named over advance by Advance and over company by Company");
  // A grant table that names groups has the column, and leaves it and the user's empty on the other's row.
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`user: "user_id", group: "group_id", role: "role"`, `user: "user_id", group: "team_id", role: "role"`))), Error, "the grant table advance_grant has no field team_id to name a group");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{name: "user_id", type: "uuid", required: false}`, `{name: "user_id", type: "uuid"}`))), Error, "a grant in advance_grant names a user or a group, so user_id is required: false");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`user: "user_id", group: "group_id", role: "role"`, `user: "user_id", group: "group_id", role: "level"`))), Error, "the grant table advance_grant has no field level to hold a role");
  // The policy compares a role with a name, and a group is one column of its row.
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{name: "user_id", type: "uuid"}, {name: "role", type: "string"}]`, `{name: "user_id", type: "uuid"}, {name: "role", type: "int32"}]`))), Error, "the grant table company_grant holds a role in role, which is a string and not int32");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{group: "finance", of: "company_id", role: "reader"}`, `{group: "finance", of: "company_id", role: "reader"}, {group: "finance", of: "company_id", role: "writer"}`))), Error, "group finance is named twice");
  // The grant table is the entity's own composition, with a role it must hold.
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`access: {scope: "folder", parent: "Advance", on: "advance_id"}`, `access: {scope: "private", owner: "user_id"}`))), Error, "entity Advance: its grant table advance_grant is an entity with access");
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{name: "user_id", type: "uuid"}, {name: "role", type: "string"}]`, `{name: "user_id", type: "uuid"}, {name: "role", type: "string", required: false}]`))), Error, "a grant in company_grant holds a role, so role is required");
  // A group is filed under by a reference, and a shared row's key is id.
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{name: "company_id", type: "uuid", ref: "company"}, {name: "amount", type: "int32"}`, `{name: "company_id", type: "uuid"}, {name: "amount", type: "int32"}`))), Error, "group finance is of company_id, which references no private or public entity");
  // The previous owner's grant is written from the row alone.
  await assertRejects(() => emitFiles(driveProgram(driveEntities.replace(`{name: "user_id", type: "uuid"}, {name: "role", type: "string"}]`, `{name: "user_id", type: "uuid"}, {name: "role", type: "string"}, {name: "note", type: "string"}]`))), Error, "a row handed to another owner grants the previous one in company_grant, which cannot fill note: give it a default");
});

Deno.test("a guard's edge from the origin emits with the program, and reads the reader's memberships", async () => {
  const files = await emitFiles(driveProgram() + `
app: state: mecha: rows: AdvanceRules: {
  entity: "Advance"
  guards: payer: {
    src: "shell/validations/payer.js"
    via: ["_origin"]
    note: "finance changes an advance"
    edges: [{table: "group_member", key: "user_id", from: "$origin"}]
    module: {statements: "", completion: "({ context, event }) => context.rows.group_member.length > 0"}
  }
  on: update: guard: "payer"
}
`);
  const machines = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(machines, `FROM group_member r WHERE r."user_id" = sender`);
  // A service's token names a subject too: the origin is a reader's alone.
  // Read through nullif: once a request's transaction has set the claims
  // LOCAL, the setting reads back as '' for the rest of the session, and
  // ''::json raised in the edge airlock's lane, which moves rows outside any
  // request (snapcards generation stalled on 2026-11-14).
  assertStringIncludes(machines, "pg_trigger_depth() = 1 AND nullif(current_setting('request.jwt.claims', true), '')::json->>'role' = 'app_user'");
});

// A handover restamps what is under the row, and a guard that refuses every
// edit of a finished child would refuse the handover with it.
Deno.test("a composition's guard does not judge the scope its parent hands down", async () => {
  const files = await emitFiles(driveProgram() + `
app: state: mecha: rows: GrantRules: {
  entity: "AdvanceGrant"
  guards: never: {
    src: "shell/validations/never.js"
    note: "a grant is not edited"
    edges: []
    module: {statements: "", completion: "() => false"}
  }
  on: update: guard: "never"
}
`);
  const machines = files["services/database/migrations/010_machines.sql"].text;
  assertStringIncludes(machines, "to_jsonb(NEW) - ARRAY['txid', 'scope_id', 'group_finance'] = to_jsonb(OLD) - ARRAY['txid', 'scope_id', 'group_finance']");
});
