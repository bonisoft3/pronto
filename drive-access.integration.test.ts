import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles } from "./effects-fixtures.ts";
import { driveProgram } from "./drive-access-fixture.ts";

// Drive's roles and groups as the emitter writes them, on mecha's database.
// Each request enters as PostgREST enters it.
const DATABASE = "bonitao/mecha-database:0.36.1@sha256:5d6f9f38a065c1c001656b4e667f875145a3179c92af0bd07f6f414c75788598";

async function docker(args: string[], input?: string) {
  const child = new Deno.Command("docker", { args, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr) };
}

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [owner, requester, approver, finance, employee, admin, outsider] = [1, 2, 3, 4, 5, 6, 7].map(uuid);
const [acme, other, mine] = [11, 12, 13].map(uuid);
const [taxi, hotel] = [21, 22].map(uuid);
const [first, second, third] = [31, 32, 33].map(uuid);

Deno.test({ name: "a grant carries a Drive role, a row names its groups, and only the owner deletes or hands over", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  // A grant is never edited, by a guard the handover's restamping must not wake.
  const files = await emitFiles(driveProgram() + `
app: state: mecha: rows: GrantRules: {
  entity: "CompanyGrant"
  guards: never: {
    src: "shell/validations/never.js"
    note: "a grant is not edited"
    edges: []
    module: {statements: "", completion: "() => false"}
  }
  on: update: guard: "never"
}
`);
  const migrations = Object.entries(files).filter(([name]) => name.startsWith("services/database/migrations/")).sort(([a], [b]) => a < b ? -1 : 1);
  const container = `pronto-drive-${crypto.randomUUID().slice(0, 8)}`;
  const started = await docker(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => docker(["exec", "-i", container, "psql", "-h", "127.0.0.1", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const service = async (sql: string) => {
    const result = await psql(sql);
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  // One request as a subject: claims and role set, then the pre-request hook.
  const as = (uid: string, method: string, sql: string) => psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"app_user"}', true) \\gset a_
    SELECT set_config('request.method', '${method}', true) \\gset b_
    SELECT set_config('request.headers', '{}', true) \\gset c_
    SET LOCAL ROLE app_user;
    SELECT app_pre_request() \\gset d_
    ${sql}
    COMMIT;`);
  const answers = async (uid: string, method: string, sql: string, want: string) => {
    const result = await as(uid, method, sql);
    assert(result.ok, result.err);
    assertEquals(result.out, want);
  };
  const refused = async (uid: string, method: string, sql: string, why: string) => {
    const result = await as(uid, method, sql);
    assertEquals(result.ok, false, `expected a refusal of: ${sql}`);
    assertStringIncludes(result.err, why);
  };
  const policy = "violates row-level security policy";
  try {
    for (let i = 0; !(await docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 120) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const [, file] of migrations) await service(file.text);
    const member = (group: string, user: string) => `(gen_random_uuid(), '${group}', '${user}')`;
    await service(`INSERT INTO group_member (id, group_id, user_id) VALUES ${[
      ...[owner, requester, approver, finance, employee].map((u) => member(`${acme}:everyone`, u)),
      member(`${acme}:admins`, admin), member(`${acme}:finance`, finance), member(`${other}:everyone`, outsider), member(`${other}:finance`, outsider),
    ].join(", ")}`);
    await answers(owner, "POST", `INSERT INTO company (id, owner_id, name) VALUES ('${acme}', '${owner}', 'Acme') RETURNING name;`, "Acme");
    await answers(outsider, "POST", `INSERT INTO company (id, owner_id, name) VALUES ('${other}', '${outsider}', 'Other') RETURNING name;`, "Other");
    await answers(owner, "POST", `INSERT INTO expense_type (id, company_id, label) VALUES ('${taxi}', '${acme}', 'Taxi') RETURNING label;`, "Taxi");

    // A reader, through everyone@acme: reads the company and what is under
    // it, and every write is a refusal, never zero rows.
    await answers(employee, "GET", "SELECT name FROM company; SELECT label FROM expense_type;", "Acme\nTaxi");
    await refused(employee, "POST", `INSERT INTO expense_type (id, company_id, label) VALUES ('${hotel}', '${acme}', 'Hotel');`, policy);
    await refused(employee, "PATCH", `UPDATE expense_type SET label = 'x' WHERE id = '${taxi}';`, policy);
    await refused(employee, "DELETE", `DELETE FROM expense_type WHERE id = '${taxi}';`, "deletes no row");
    await refused(employee, "PATCH", `UPDATE company SET name = 'x' WHERE id = '${acme}';`, policy);
    await refused(employee, "PATCH", `UPDATE company SET owner_id = '${employee}' WHERE id = '${acme}';`, "only the owner hands a row to another");
    await refused(employee, "DELETE", `DELETE FROM company WHERE id = '${acme}';`, "only the owner deletes a row");
    await refused(employee, "POST", `INSERT INTO company_grant (id, company_id, user_id, role) VALUES (gen_random_uuid(), '${acme}', '${employee}', 'writer');`, policy);
    await refused(employee, "POST", `INSERT INTO group_member (id, group_id, user_id) VALUES (gen_random_uuid(), '${acme}:admins', '${employee}');`, policy);

    // A writer, through admins@acme: changes the company and what is under
    // it, its grants among them, and does not own it.
    await answers(admin, "POST", `INSERT INTO expense_type (id, company_id, label) VALUES ('${hotel}', '${acme}', 'Hotel') RETURNING label;`, "Hotel");
    await answers(admin, "PATCH", `UPDATE company SET name = 'Acme SA' WHERE id = '${acme}' RETURNING name;`, "Acme SA");
    await refused(admin, "PATCH", `UPDATE company SET owner_id = '${admin}' WHERE id = '${acme}';`, "only the owner hands a row to another");
    await answers(admin, "POST", `INSERT INTO company_grant (id, company_id, user_id, role) VALUES (gen_random_uuid(), '${acme}', '${approver}', 'reader') RETURNING role;`, "reader");
    await answers(admin, "DELETE", `DELETE FROM company_grant WHERE company_id = '${acme}' AND user_id = '${approver}' RETURNING role;`, "reader");
    await refused(admin, "DELETE", `DELETE FROM company WHERE id = '${acme}';`, "only the owner deletes a row");
    await answers(admin, "DELETE", `DELETE FROM expense_type WHERE id = '${hotel}' RETURNING label;`, "Hotel");

    // What is under a company leaves it by a role that writes there: a reader
    // with a company of their own moves neither a row nor a grant into it.
    await answers(employee, "POST", `INSERT INTO company (id, owner_id, name) VALUES ('${mine}', '${employee}', 'Mine') RETURNING name;`, "Mine");
    await refused(employee, "PATCH", `UPDATE expense_type SET company_id = '${mine}' WHERE id = '${taxi}';`, "moves no row out of it");
    await answers(admin, "PATCH", `UPDATE expense_type SET label = 'Cab' WHERE id = '${taxi}' RETURNING label;`, "Cab");

    // The owner grants a user, and hands the company over and takes it back.
    await answers(owner, "POST", `INSERT INTO company_grant (id, company_id, user_id, role) VALUES (gen_random_uuid(), '${acme}', '${approver}', 'reader') RETURNING role;`, "reader");
    // Whoever hands it over is left its writer, by a grant the cluster
    // writes, and the grant of whoever receives it is spent.
    const grants = `SELECT coalesce(string_agg(user_id::text || ' ' || role, ',' ORDER BY role, user_id), '') FROM company_grant WHERE company_id = '${acme}'`;
    await answers(owner, "PATCH", `UPDATE company SET owner_id = '${admin}' WHERE id = '${acme}' RETURNING owner_id;`, admin);
    assertEquals(await service(grants), `${approver} reader,${owner} writer`);
    // What is under the company goes with it: a row left with the scope of
    // whoever handed it over would still sync to them.
    const scopes = `SELECT string_agg(DISTINCT scope_id, ',') FROM (SELECT scope_id FROM expense_type WHERE company_id = '${acme}' UNION ALL SELECT scope_id FROM company_grant WHERE company_id = '${acme}') s`;
    assertEquals(await service(scopes), `user:${admin}`);
    await refused(admin, "PATCH", `UPDATE company_grant SET role = 'writer' WHERE company_id = '${acme}' AND user_id = '${approver}';`, "validation company_grant.never");
    await answers(owner, "PATCH", `UPDATE company SET name = 'Acme' WHERE id = '${acme}' RETURNING name;`, "Acme");
    await refused(owner, "DELETE", `DELETE FROM company WHERE id = '${acme}';`, "only the owner deletes a row");
    await refused(owner, "PATCH", `UPDATE company SET owner_id = '${owner}' WHERE id = '${acme}';`, "only the owner hands a row to another");
    await answers(admin, "PATCH", `UPDATE company SET owner_id = '${owner}' WHERE id = '${acme}' RETURNING owner_id;`, owner);
    assertEquals(await service(grants), `${approver} reader,${admin} writer`);

    // An outsider reads nothing of the company and writes nothing into it.
    await answers(outsider, "GET", `SELECT (SELECT count(*) FROM company WHERE id = '${acme}') + (SELECT count(*) FROM expense_type) + (SELECT count(*) FROM company_grant);`, "0");
    await refused(outsider, "POST", `INSERT INTO expense_type (id, company_id, label) VALUES (gen_random_uuid(), '${acme}', 'Spy');`, "Key is not present");

    // An advance: its requester's, one user's by a grant, finance's by the
    // group its company column names. Nobody files one into a company they
    // do not read, or under another owner.
    const advance = (id: string, by: string, company: string, amount: number) => `INSERT INTO advance (id, owner_id, company_id, amount) VALUES ('${id}', '${by}', '${company}', ${amount}) RETURNING amount;`;
    await answers(requester, "POST", advance(first, requester, acme, 100), "100");
    await answers(employee, "POST", advance(second, employee, acme, 200), "200");
    await answers(approver, "POST", advance(third, approver, acme, 300), "300");
    await refused(outsider, "POST", advance(uuid(34), outsider, acme, 999), policy);
    await refused(requester, "POST", advance(uuid(34), employee, acme, 999), policy);
    await answers(requester, "POST", `INSERT INTO advance_grant (id, advance_id, user_id, role) VALUES (gen_random_uuid(), '${first}', '${approver}', 'reader') RETURNING group_finance;`, `${acme}:finance`);
    // A grant holds a role Drive has, and only the owner files the advance
    // under another company's finance.
    await refused(requester, "POST", `INSERT INTO advance_grant (id, advance_id, user_id, role) VALUES (gen_random_uuid(), '${first}', '${employee}', 'editor');`, "violates check constraint");
    await refused(approver, "PATCH", `UPDATE advance SET company_id = NULL WHERE id = '${first}';`, "only the owner files a row under another finance");
    await refused(approver, "POST", `INSERT INTO advance_grant (id, advance_id, user_id, role) VALUES (gen_random_uuid(), '${first}', '${employee}', 'reader');`, policy);
    const sees = "SELECT coalesce(string_agg(amount::text, ' ' ORDER BY amount), 'none') FROM advance;";
    await answers(requester, "GET", sees, "100");
    await answers(employee, "GET", sees, "200");
    await answers(approver, "GET", sees, "100 300");
    await answers(finance, "GET", sees, "100 200 300");
    await answers(owner, "GET", sees, "none");
    await answers(outsider, "GET", sees, "none");
    await refused(finance, "PATCH", `UPDATE advance SET amount = 1 WHERE id = '${first}';`, policy);
    await refused(approver, "PATCH", `UPDATE advance SET amount = 1 WHERE id = '${first}';`, policy);
    await refused(finance, "DELETE", `DELETE FROM advance WHERE id = '${first}';`, "only the owner deletes a row");
    await refused(requester, "PATCH", `UPDATE advance SET company_id = '${other}' WHERE id = '${first}';`, policy);
    await answers(requester, "PATCH", `UPDATE advance SET amount = 150 WHERE id = '${first}' RETURNING amount;`, "150");

    // The sync path asks reach as the subject, and a group is one shape.
    const reach = (table: string, column: string, value: string) => `SELECT mecha.shape_reach('public.${table}', '${column}', '${value}');`;
    await answers(finance, "GET", reach("advance", "group_finance", `${acme}:finance`), "t");
    await answers(finance, "GET", reach("advance_grant", "group_finance", `${acme}:finance`), "t");
    await answers(requester, "GET", reach("advance", "group_finance", `${acme}:finance`), "f");
    await answers(outsider, "GET", reach("advance", "group_finance", `${acme}:finance`), "f");
    await answers(approver, "GET", reach("advance", "id", first), "t");
    await answers(employee, "GET", reach("advance", "id", first), "f");
    await answers(employee, "GET", reach("expense_type", "company_id", acme), "t");
    await answers(outsider, "GET", reach("expense_type", "company_id", acme), "f");
    await answers(outsider, "GET", reach("group_member", "user_id", finance), "f");
    // What the shapes a subject is authorized for deliver is what RLS shows.
    for (const uid of [requester, employee, approver, finance, owner, outsider]) {
      const shown = (await as(uid, "GET", "SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM advance;")).out;
      const groups = (await as(uid, "GET", `SELECT coalesce(string_agg(quote_literal(group_id), ','), 'NULL') FROM group_member WHERE mecha.shape_reach('public.advance', 'group_finance', group_id);`)).out;
      const rows = (await as(uid, "GET", `SELECT coalesce(string_agg(quote_literal(advance_id), ','), 'NULL') FROM advance_grant WHERE user_id = '${uid}' AND mecha.shape_reach('public.advance', 'id', advance_id::text);`)).out;
      const delivered = await service(`SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM advance
        WHERE scope_id = ANY (public.subject_scopes('${uid}')) OR group_finance IN (${groups}) OR id::text IN (${rows});`);
      assertEquals(delivered, shown, `shapes and RLS differ for ${uid}`);
    }

    // One advance shared with a group by a grant row, as with a user by
    // another: its members hold the row's role while they are members, the
    // grant fills one grantee, and only the owner writes it, since an
    // advance's writers do not share.
    const approvers = "approvers@acme";
    const group = (advance: string, name: string, role: string) => `INSERT INTO advance_grant (id, advance_id, group_id, role) VALUES (gen_random_uuid(), '${advance}', '${name}', '${role}') RETURNING role;`;
    await service(`INSERT INTO group_member (id, group_id, user_id) VALUES ${member(approvers, admin)}`);
    await answers(admin, "GET", sees, "none");
    await refused(finance, "POST", group(second, approvers, "writer"), policy);
    await answers(employee, "POST", group(second, approvers, "writer"), "writer");
    await refused(employee, "POST", `INSERT INTO advance_grant (id, advance_id, user_id, group_id, role) VALUES (gen_random_uuid(), '${second}', '${approver}', '${approvers}', 'reader');`, "violates check constraint");
    await refused(employee, "POST", `INSERT INTO advance_grant (id, advance_id, role) VALUES (gen_random_uuid(), '${second}', 'reader');`, "violates check constraint");
    await answers(admin, "GET", sees, "200");
    await answers(admin, "PATCH", `UPDATE advance SET amount = 200 WHERE id = '${second}' RETURNING amount;`, "200");
    await refused(admin, "DELETE", `DELETE FROM advance WHERE id = '${second}';`, "only the owner deletes a row");
    await refused(admin, "POST", group(second, `${acme}:everyone`, "writer"), policy);
    await answers(outsider, "GET", sees, "none");
    // The group's grants are one shape over the grant table, and each names a row.
    await answers(admin, "GET", reach("advance_grant", "group_id", approvers), "t");
    await answers(outsider, "GET", reach("advance_grant", "group_id", approvers), "f");
    await answers(admin, "GET", reach("advance", "id", second), "t");
    const granted = (await as(admin, "GET", `SELECT coalesce(string_agg(quote_literal(g.advance_id), ','), 'NULL') FROM advance_grant g JOIN group_member m ON m.group_id = g.group_id WHERE mecha.shape_reach('public.advance_grant', 'group_id', m.group_id) AND mecha.shape_reach('public.advance', 'id', g.advance_id::text);`)).out;
    assertEquals(await service(`SELECT coalesce(string_agg(id::text, ','), '') FROM advance WHERE id::text IN (${granted});`), second);
    await service(`DELETE FROM group_member WHERE group_id = '${approvers}' AND user_id = '${admin}'`);
    await answers(admin, "GET", sees, "none");
    await answers(admin, "GET", reach("advance_grant", "group_id", approvers), "f");
    await answers(admin, "GET", reach("advance", "id", second), "f");

    // An advance moved to another company takes its grants into that
    // company's group, though the mover edits no grant.
    await service(`INSERT INTO group_member (id, group_id, user_id) VALUES ${member(`${other}:everyone`, requester)}`);
    await answers(requester, "PATCH", `UPDATE advance SET company_id = '${other}' WHERE id = '${first}' RETURNING group_finance;`, `${other}:finance`);
    assertEquals(await service(`SELECT DISTINCT group_finance FROM advance_grant WHERE advance_id = '${first}'`), `${other}:finance`);
    await answers(requester, "PATCH", `UPDATE advance SET company_id = '${acme}' WHERE id = '${first}' RETURNING group_finance;`, `${acme}:finance`);
    await service(`DELETE FROM group_member WHERE group_id = '${other}:everyone' AND user_id = '${requester}'`);

    // Leaving the group revokes both paths at once.
    await service(`DELETE FROM group_member WHERE group_id = '${acme}:finance' AND user_id = '${finance}'`);
    await answers(finance, "GET", sees, "none");
    await answers(finance, "GET", reach("advance", "group_finance", `${acme}:finance`), "f");
  } finally {
    await docker(["rm", "-f", container]);
  }
} });
