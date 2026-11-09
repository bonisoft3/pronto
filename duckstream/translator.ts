export interface Type {
  type: string;
  nullable: boolean;
  precision?: number;
  scale?: number;
}
export interface Field {
  name: string;
  columntype: Type;
  lateness?: string;
}
export interface Relation {
  name: string;
  fields: Field[];
  properties?: Record<string, unknown>;
  materialized: boolean;
  foreign_keys?: unknown[];
}
export interface Schema {
  inputs: Relation[];
  outputs: Relation[];
}
interface Expression {
  input?: number;
  literal?: unknown;
  type?: Type;
  op?: { name: string };
  operands?: Expression[];
}
interface Aggregate {
  agg: { name: string };
  type: Type;
  distinct: boolean;
  operands: number[];
  name: string;
}
interface Node {
  id: number;
  relOp: string;
  inputs: number[];
  table?: string[];
  fields?: string[];
  exprs?: Expression[];
  condition?: Expression;
  matchCondition?: Expression;
  joinType?: string;
  group?: number[];
  aggs?: Aggregate[];
  invocation?: Expression;
  rowType?: { fields: (Type & { name: string })[]; nullable: boolean };
  all?: boolean;
  type?: (Type & { name: string })[];
  tuples?: Expression[][];
}
export type Plan = Record<string, { rels: Node[] }>;
interface Lowered {
  sql: string;
  types: Type[];
}
export interface PhysicalQuery {
  sql: string;
  stages: { name: string; sql: string }[];
}
export function require(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`OUTSIDE_EXPORT_PROFILE: ${reason}`);
}
class NumericToken {
  constructor(readonly source: string) {}
}
export function parse(text: string): unknown {
  const read = JSON.parse as (
    s: string,
    r: (k: string, v: unknown, c?: { source?: string }) => unknown,
  ) => unknown;
  return read(text, (_key, value, context) => {
    if (typeof value === "number") {
      require(context?.source, "JSON numeric token context required");
      if (!/^-?(0|[1-9][0-9]*)$/.test(context.source)) {
        return new NumericToken(context.source);
      }
      require(
        Number.isSafeInteger(value) && BigInt(context.source) === BigInt(value),
        "unsafe JSON integer",
      );
    }
    return value;
  });
}
export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
export function type(t: Type): string {
  require(
    [
      "INTEGER",
      "BIGINT",
      "BOOLEAN",
      "VARCHAR",
      "TIMESTAMP",
      "DOUBLE",
      "DATE",
      "UUID",
      "DECIMAL",
    ].includes(t.type),
    `type ${t.type}`,
  );
  if (t.type === "TIMESTAMP") {
    require(t.precision === 6, "TIMESTAMP(6)");
  }
  if (t.type === "DECIMAL") {
    require(
      Number.isInteger(t.precision) && Number.isInteger(t.scale) &&
        t.precision! >= 1 && t.precision! <= 28 &&
        t.scale! >= 0 && t.scale! <= t.precision!,
      "DECIMAL precision 1..28 and scale 0..precision",
    );
    return `DECIMAL(${t.precision},${t.scale})`;
  }
  return t.type;
}
function names(values: string[], scope: string) {
  require(
    new Set(values.map((v) => v.toLowerCase())).size === values.length,
    `case collision in ${scope}`,
  );
}
export function admitSchema(schema: Schema, view = "result"): Relation {
  keys(schema, ["inputs", "outputs"]);
  require(schema.inputs.length > 0, "base tables required");
  const outputs = schema.outputs.filter((r) => r.name !== "error_view");
  require(
    outputs.some((output) => output.name === view),
    "selected output view",
  );
  names([...schema.inputs, ...outputs].map((r) => r.name), "relations");
  for (const relation of [...schema.inputs, ...outputs]) {
    keys(relation, [
      "name",
      "case_sensitive",
      "fields",
      "primary_key",
      "properties",
      "materialized",
      "foreign_keys",
    ]);
    require(
      !relation.materialized || outputs.includes(relation),
      "materialized input relation",
    );
    require(
      !relation.properties || Object.keys(relation.properties).length === 0,
      `relation properties: ${
        Object.keys(relation.properties ?? {}).join(",")
      }`,
    );
    require(!relation.foreign_keys?.length, "foreign keys");
    names(relation.fields.map((f) => f.name), `${relation.name} columns`);
    for (const field of relation.fields) {
      keys(field, [
        "name",
        "case_sensitive",
        "columntype",
        "unused",
        "lateness",
        "default",
      ]);
      require(!("lateness" in field), "LATENESS");
      require(!("default" in field), "column default");
      type(field.columntype);
    }
  }
  return outputs.find((output) => output.name === view)!;
}
function pick<T>(values: T[], index: number): T {
  require(
    Number.isInteger(index) && index >= 0 && index < values.length,
    "ordinal out of bounds",
  );
  return values[index];
}
function fixedMicros(e: Expression): number {
  require(
    e.type &&
      ["INTERVAL_DAY", "INTERVAL_HOUR", "INTERVAL_MINUTE", "INTERVAL_SECOND"]
        .includes(e.type.type) &&
      typeof e.literal === "number" && Number.isSafeInteger(e.literal),
    "fixed interval literal",
  );
  const value = e.literal * 1000;
  require(Number.isSafeInteger(value), "exact interval microseconds");
  return value;
}
function timestampMicros(sql: string): string {
  return `(CASE WHEN ${sql} IS NULL OR isfinite(${sql}) THEN epoch_us(${sql}) ELSE error('finite TIMESTAMP required') END)`;
}
function expression(
  e: Expression,
  refs: string[],
  types: Type[],
): { sql: string; type: Type } {
  require(e && typeof e === "object", "missing expression; compile with -v 1");
  if (e.input !== undefined) {
    return { sql: pick(refs, e.input), type: pick(types, e.input) };
  }
  if ("literal" in e) {
    require(e.type, "typed literal");
    if (e.type.type === "INTERVAL_YEAR") {
      require(
        typeof e.literal === "number" && Number.isSafeInteger(e.literal) &&
          e.literal % 12 === 0 && Math.abs(e.literal) <= 2147483647,
        "exact calendar year interval",
      );
      return { sql: `to_months(${e.literal})`, type: e.type };
    }
    if (e.type.type.startsWith("INTERVAL_")) {
      return { sql: `CAST(${fixedMicros(e)} AS BIGINT)`, type: e.type };
    }
    if (e.type.type === "CHAR") {
      require(typeof e.literal === "string", "CHAR string literal");
      return {
        sql: `'${e.literal.replaceAll("'", "''")}'`,
        type: { type: "VARCHAR", nullable: false },
      };
    }
    if (e.type.type === "TIMESTAMP" && e.literal !== null) {
      require(
        Number.isInteger(e.type.precision) && e.type.precision! >= 0 &&
          e.type.precision! <= 3 && typeof e.literal === "number" &&
          Number.isSafeInteger(e.literal),
        "TIMESTAMP literal with exact exported milliseconds",
      );
      const micros = BigInt(e.literal) * 1000n;
      require(
        micros > -9223372036854775808n && micros < 9223372036854775807n,
        "finite TIMESTAMP literal microseconds",
      );
      return {
        sql: `make_timestamp(CAST(${micros} AS BIGINT))`,
        type: { type: "TIMESTAMP", precision: 6, nullable: false },
      };
    }
    const t = type(e.type);
    if (e.literal === null) return { sql: `CAST(NULL AS ${t})`, type: e.type };
    if (["INTEGER", "BIGINT"].includes(t)) {
      require(
        typeof e.literal === "number" && Number.isSafeInteger(e.literal),
        "integer literal",
      );
    } else if (t === "DOUBLE") {
      require(
        e.literal instanceof NumericToken ||
          typeof e.literal === "number" && Number.isSafeInteger(e.literal),
        "DOUBLE literal numeric token",
      );
      const token = e.literal instanceof NumericToken
        ? e.literal.source
        : String(e.literal);
      require(Number.isFinite(Number(token)), "finite DOUBLE literal");
      return { sql: `CAST(${token} AS DOUBLE)`, type: e.type };
    } else if (t === "VARCHAR") {
      require(typeof e.literal === "string", "string literal");
    } else if (t === "BOOLEAN") {
      require(typeof e.literal === "boolean", "boolean literal");
    } else require(false, `literal ${t}`);
    return {
      sql: t === "VARCHAR"
        ? `'${String(e.literal).replaceAll("'", "''")}'`
        : `CAST(${String(e.literal)} AS ${t})`,
      type: e.type,
    };
  }
  require(e.op && e.operands, "operator expression");
  if (e.op.name === "SEARCH") {
    require(e.operands.length === 2, "SEARCH arity");
    const value = expression(e.operands[0], refs, types);
    const literal = e.operands[1];
    require(
      value.type.type === "VARCHAR" && literal.type?.type === "VARCHAR" &&
        literal.literal && typeof literal.literal === "object",
      "VARCHAR singleton SEARCH",
    );
    const ranges = literal.literal as { rangeSet: unknown[]; nullAs: string };
    keys(ranges, ["rangeSet", "nullAs"]);
    require(
      ranges.nullAs === "UNKNOWN" && Array.isArray(ranges.rangeSet) &&
        ranges.rangeSet.length > 0,
      "SEARCH unknown null and nonempty ranges",
    );
    const items = ranges.rangeSet.map((range) => {
      require(
        Array.isArray(range) && range.length === 2 &&
          range[0] === "singleton" &&
          typeof range[1] === "string",
        "SEARCH singleton string range",
      );
      const item = JSON.parse(range[1]);
      keys(item, [
        "value",
        "charsetName",
        "collation",
        "charset",
        "valueBytes",
      ]);
      require(
        typeof item.value === "string" && item.charsetName === "UTF-8" &&
          item.charset === "UTF-8" && item.valueBytes === null &&
          item.collation,
        "SEARCH UTF-8 string",
      );
      keys(item.collation, ["collationName", "coercibility", "locale"]);
      require(
        item.collation.collationName === "ISO-8859-1$en_US$primary" &&
          item.collation.coercibility === "IMPLICIT" &&
          item.collation.locale === "en_US",
        "SEARCH default collation",
      );
      return `'${item.value.replaceAll("'", "''")}'`;
    });
    return {
      sql: `(${value.sql} IN (${items.join(", ")}))`,
      type: { type: "BOOLEAN", nullable: value.type.nullable },
    };
  }
  if (e.op.name === "FLOOR") {
    require(
      e.operands.length === 2 && e.operands[1].type?.type === "SYMBOL" &&
        e.operands[1].literal === "MONTH",
      "timestamp FLOOR TO MONTH",
    );
    const value = expression(e.operands[0], refs, types);
    require(value.type.type === "TIMESTAMP", "timestamp FLOOR input");
    return {
      sql: `date_trunc('month', make_timestamp(${timestampMicros(value.sql)}))`,
      type: value.type,
    };
  }
  const values = e.operands.map((a) => expression(a, refs, types));
  const args = values.map((a) => a.sql);
  const op = e.op.name;
  let sql: string;
  let result: Type = { type: "BOOLEAN", nullable: true };
  const commonType = (items: { type: Type }[]) => {
    require(items.length > 0, "typed operands");
    const first = items[0].type;
    if (items.every((v) => type(v.type) === type(first))) {
      return { ...first, nullable: items.some((v) => v.type.nullable) };
    }
    require(
      items.every((v) => ["INTEGER", "BIGINT", "DOUBLE"].includes(v.type.type)),
      "compatible expression types",
    );
    return {
      type: items.some((v) => v.type.type === "DOUBLE") ? "DOUBLE" : "BIGINT",
      nullable: items.some((v) => v.type.nullable),
    };
  };
  if (["=", "<>", "<", ">", "<=", ">=", "AND", "OR"].includes(op)) {
    require(args.length >= 2, "binary arity");
    sql = `(${args.join(` ${op} `)})`;
  } else if (["IS NULL", "IS NOT NULL", "IS TRUE"].includes(op)) {
    require(args.length === 1, "null test arity");
    require(
      op !== "IS TRUE" || values[0].type.type === "BOOLEAN",
      "IS TRUE boolean",
    );
    sql = `(${args[0]} ${op})`;
  } else if (op === "NOT") {
    require(args.length === 1, "NOT arity");
    sql = `(NOT ${args[0]})`;
  } else if (op === "CAST") {
    require(args.length === 1 && e.type, "typed CAST");
    const source = values[0].type;
    const target = e.type;
    if (source.type === "INTERVAL_SECOND") {
      require(
        ["INTEGER", "BIGINT"].includes(target.type),
        "interval seconds integer cast",
      );
      return {
        sql: `CAST((${args[0]} // 1000000) AS ${type(target)})`,
        type: target,
      };
    }
    require(
      target.type !== "VARCHAR" || target.precision === undefined ||
        target.precision === -1,
      "bounded VARCHAR cast",
    );
    if (source.type === "DECIMAL" || target.type === "DECIMAL") {
      require(
        source.type === "DECIMAL" && target.type === "DECIMAL" &&
          target.scale! >= source.scale! &&
          target.precision! - target.scale! >=
            source.precision! - source.scale!,
        "lossless DECIMAL cast",
      );
    } else {
      require(
        type(source) === type(target) ||
          ["INTEGER", "BIGINT", "DOUBLE"].includes(source.type) &&
            ["INTEGER", "BIGINT", "DOUBLE"].includes(target.type) ||
          target.type === "VARCHAR" &&
            ["UUID", "DATE", "INTEGER", "BIGINT"].includes(source.type),
        "CAST type pair",
      );
      require(
        source.type !== "DOUBLE" || target.type === "DOUBLE",
        "DOUBLE narrowing cast",
      );
    }
    result = target;
    sql = `CAST(${args[0]} AS ${type(target)})`;
  } else if (["+", "-", "*"].includes(op)) {
    require(args.length === 2, "arithmetic arity");
    if (values[0].type.type === "TIMESTAMP") {
      if (op === "+" && values[1].type.type.startsWith("INTERVAL_")) {
        require(
          e.operands[1].literal !== undefined,
          "literal timestamp interval",
        );
        if (values[1].type.type === "INTERVAL_YEAR") {
          return {
            sql: `(make_timestamp(${timestampMicros(args[0])}) + ${args[1]})`,
            type: values[0].type,
          };
        }
        return {
          sql: `make_timestamp(CAST((${timestampMicros(args[0])}::HUGEINT + ${
            args[1]
          }) AS BIGINT))`,
          type: values[0].type,
        };
      }
      require(
        op === "-" && values[1].type.type === "TIMESTAMP" &&
          e.type?.type === "INTERVAL_SECOND",
        "timestamp difference in seconds",
      );
      return {
        sql: `CAST((${timestampMicros(args[0])}::HUGEINT - ${
          timestampMicros(args[1])
        }::HUGEINT) AS BIGINT)`,
        type: e.type,
      };
    }
    require(
      values.every((v) =>
        ["INTEGER", "BIGINT", "DOUBLE"].includes(v.type.type)
      ),
      "arithmetic INTEGER/BIGINT/DOUBLE",
    );
    result = commonType(values);
    sql = `CAST((${args[0]} ${op} ${args[1]}) AS ${type(result)})`;
  } else if (op === "/" || op === "MOD") {
    require(
      args.length === 2 &&
        values.every((v) => ["INTEGER", "BIGINT"].includes(v.type.type)) &&
        typeof e.operands[1].literal === "number" &&
        Number.isSafeInteger(e.operands[1].literal) &&
        e.operands[1].literal > 0,
      "integer division/modulo by positive literal",
    );
    result = op === "MOD"
      ? { ...values[1].type, nullable: values.some((v) => v.type.nullable) }
      : commonType(values);
    sql = `CAST((${args[0]} ${op === "/" ? "//" : "%"} ${args[1]}) AS ${
      type(result)
    })`;
  } else if (op === "POSITION") {
    require(
      args.length === 2 && values.every((v) => v.type.type === "VARCHAR"),
      "VARCHAR POSITION",
    );
    result = { type: "INTEGER", nullable: values.some((v) => v.type.nullable) };
    sql = `CAST(strpos(${args[1]}, ${args[0]}) AS INTEGER)`;
  } else if (op === "SUBSTRING") {
    require(
      (args.length === 2 || args.length === 3) &&
        values[0].type.type === "VARCHAR" &&
        e.operands.slice(1).every((operand, i) =>
          ["INTEGER", "BIGINT"].includes(values[i + 1].type.type) &&
          (!("literal" in operand) || operand.literal === null ||
            typeof operand.literal === "number" &&
              Number.isSafeInteger(operand.literal) &&
              operand.literal >= (i === 0 ? 1 : 0))
        ),
      "SUBSTRING positive literal start and nonnegative literal length",
    );
    result = { type: "VARCHAR", nullable: values.some((v) => v.type.nullable) };
    const dynamic = e.operands.slice(1).some((operand) =>
      !("literal" in operand)
    );
    const substring = `substring(${args.join(", ")})`;
    sql = dynamic
      ? `CASE WHEN ${
        args.map((arg) => `${arg} IS NULL`).join(" OR ")
      } THEN NULL WHEN ${args[1]} >= 1${
        args.length === 3 ? ` AND ${args[2]} >= 0` : ""
      } THEN ${substring} ELSE error('SUBSTRING bounds outside positive-start/nonnegative-length profile') END`
      : substring;
  } else if (op === "||") {
    require(
      args.length === 2 && values.every((v) => v.type.type === "VARCHAR"),
      "VARCHAR concatenation",
    );
    result = { type: "VARCHAR", nullable: values.some((v) => v.type.nullable) };
    sql = `(${args[0]} || ${args[1]})`;
  } else if (op === "COALESCE") {
    require(args.length >= 2, "COALESCE arity");
    result = commonType(values);
    sql = `COALESCE(${args.join(", ")})`;
  } else if (op === "CASE") {
    require(args.length >= 3 && args.length % 2 === 1, "CASE arity");
    const branches = values.filter((_, i) =>
      i % 2 === 1 || i === args.length - 1
    );
    result = commonType(branches);
    const arms = args.slice(0, -1).filter((_, i) => i % 2 === 0).map(
      (condition, i) => {
        require(values[i * 2].type.type === "BOOLEAN", "CASE condition");
        return `WHEN ${condition} THEN ${args[i * 2 + 1]}`;
      },
    );
    sql = `CASE ${arms.join(" ")} ELSE ${args.at(-1)} END`;
  } else throw new Error(`OUTSIDE_EXPORT_PROFILE: operator ${op}`);
  return { sql, type: result };
}
const refs = (types: Type[], alias: string) =>
  types.map((_, i) => `${alias}.c${i}`);
const select = (items: string[]) =>
  `SELECT ${items.map((e, i) => `${e} AS c${i}`).join(", ")}`;
function keys(value: object, allowed: string[]) {
  require(
    Object.keys(value).every((k) => allowed.includes(k)),
    `unknown fields: ${Object.keys(value).filter((k) => !allowed.includes(k))}`,
  );
}
export function translate(plan: Plan, schema: Schema, view = "result"): string {
  return lower(plan, schema, view);
}

export function translatePhysical(
  plan: Plan,
  schema: Schema,
  view: string,
  prefix: string,
): PhysicalQuery {
  require(
    /^__duckstream_[a-z][a-z0-9_]*$/.test(prefix),
    "physical stage namespace",
  );
  const stages: PhysicalQuery["stages"] = [];
  return { sql: lower(plan, schema, view, { prefix, stages }), stages };
}

function physicalColumns(plan: Plan, schema: Schema, view: string) {
  type Scope = {
    nodes: Map<number, Node>;
    widths: Map<number, number>;
    live: Map<number, Set<number>>;
    root: number;
  };
  const scopes = new Map<string, Scope>();
  const active = new Set<string>();
  const scope = (name: string): Scope => {
    const cached = scopes.get(name);
    if (cached) return cached;
    require(plan[name] && !active.has(name), "physical view dependency");
    active.add(name);
    const nodes = new Map<number, Node>();
    const widths = new Map<number, number>();
    for (const node of plan[name].rels) {
      require(!nodes.has(node.id), "duplicate node ID");
      const inputs = node.inputs.map((id) => {
        const width = widths.get(id);
        require(width !== undefined, "non-topological input");
        return width;
      });
      let width: number | undefined;
      switch (node.relOp) {
        case "LogicalTableScan": {
          const table = node.table?.[1];
          require(table, "physical table scan");
          const input = schema.inputs.find((input) => input.name === table);
          const local = input ? undefined : scope(table);
          width = input?.fields.length ?? local!.widths.get(local!.root);
          break;
        }
        case "LogicalValues":
          width = node.type?.length;
          break;
        case "LogicalProject":
          width = node.exprs?.length;
          break;
        case "LogicalFilter":
        case "LogicalUnion":
          width = inputs[0];
          break;
        case "LogicalJoin":
        case "LogicalAsofJoin":
          width = inputs[0] + inputs[1];
          break;
        case "LogicalAggregate":
          width = node.group && node.aggs
            ? node.group.length + node.aggs.length
            : undefined;
          break;
        case "LogicalTableFunctionScan":
          width = node.rowType?.fields.length;
          break;
        default:
          throw new Error(`OUTSIDE_EXPORT_PROFILE: node ${node.relOp}`);
      }
      require(Number.isInteger(width) && width! >= 0, "physical node width");
      nodes.set(node.id, node);
      widths.set(node.id, width!);
    }
    const root = plan[name].rels.at(-1)?.id;
    require(root !== undefined, "empty plan");
    const result = {
      nodes,
      widths,
      live: new Map<number, Set<number>>(),
      root,
    };
    scopes.set(name, result);
    active.delete(name);
    return result;
  };
  const pending: { name: string; id: number }[] = [];
  const demand = (name: string, id: number, columns: Iterable<number>) => {
    const current = scope(name);
    const width = current.widths.get(id);
    require(width !== undefined, "physical node demand");
    let live = current.live.get(id);
    let changed = !live;
    if (!live) current.live.set(id, live = new Set());
    for (const column of columns) {
      require(
        Number.isInteger(column) && column >= 0 && column < width,
        "physical column demand",
      );
      if (!live.has(column)) {
        live.add(column);
        changed = true;
      }
    }
    if (changed) pending.push({ name, id });
  };
  const references = (
    expression: Expression | undefined,
    into: Set<number>,
  ) => {
    if (!expression) return;
    if (expression.input !== undefined) into.add(expression.input);
    expression.operands?.forEach((operand) => references(operand, into));
  };
  const all = (width: number) => Array.from({ length: width }, (_, i) => i);
  const root = scope(view);
  demand(view, root.root, all(root.widths.get(root.root)!));
  for (let i = 0; i < pending.length; i++) {
    const { name, id } = pending[i];
    const current = scope(name);
    const node = current.nodes.get(id)!;
    const live = current.live.get(id)!;
    const input = new Set<number>();
    switch (node.relOp) {
      case "LogicalTableScan": {
        const table = node.table![1];
        if (!schema.inputs.some((input) => input.name === table)) {
          demand(table, scope(table).root, live);
        }
        break;
      }
      case "LogicalValues":
        break;
      case "LogicalProject":
        for (const column of live) references(pick(node.exprs!, column), input);
        demand(name, node.inputs[0], input);
        break;
      case "LogicalFilter":
        live.forEach((column) => input.add(column));
        references(node.condition, input);
        demand(name, node.inputs[0], input);
        break;
      case "LogicalJoin":
      case "LogicalAsofJoin": {
        live.forEach((column) => input.add(column));
        references(node.condition, input);
        references(node.matchCondition, input);
        const left = current.widths.get(node.inputs[0])!;
        demand(
          name,
          node.inputs[0],
          [...input].filter((column) => column < left),
        );
        demand(
          name,
          node.inputs[1],
          [...input].filter((column) => column >= left).map((column) =>
            column - left
          ),
        );
        break;
      }
      case "LogicalAggregate":
        node.group!.forEach((column) => input.add(column));
        for (const column of live) {
          if (column >= node.group!.length) {
            pick(node.aggs!, column - node.group!.length).operands.forEach((
              operand,
            ) => input.add(operand));
          }
        }
        demand(name, node.inputs[0], input);
        break;
      case "LogicalUnion":
        for (const id of node.inputs) {
          demand(name, id, node.all ? live : all(current.widths.get(id)!));
        }
        break;
      case "LogicalTableFunctionScan":
        for (const column of live) {
          if (column < current.widths.get(node.inputs[0])!) input.add(column);
        }
        references(node.invocation, input);
        demand(name, node.inputs[0], input);
        break;
    }
  }
  return scopes;
}

function lower(
  plan: Plan,
  schema: Schema,
  view: string,
  physical?: { prefix: string; stages: PhysicalQuery["stages"] },
): string {
  const output = admitSchema(schema, view);
  const live = physical ? physicalColumns(plan, schema, view) : undefined;
  const compiled = new Map<string, Lowered>();
  const active = new Set<string>();
  const ctes: string[] = [];
  const reserved = new Set(
    schema.inputs.map((relation) => relation.name.toLowerCase()),
  );
  let next = 0;
  const materialize = (input: Lowered, columns: Set<number>): Lowered => {
    let name: string;
    do {
      name = `${physical!.prefix}_${next++}`;
    } while (reserved.has(name));
    reserved.add(name);
    const retained = input.types.flatMap((_, i) =>
      columns.has(i) ? [`v.c${i} AS c${i}`] : []
    );
    physical!.stages.push({
      name,
      sql: columns.size === input.types.length
        ? input.sql
        : `SELECT ${
          retained.length ? retained.join(", ") : "1 AS __row"
        } FROM (${input.sql}) v`,
    });
    return {
      sql: `${
        select(input.types.map((t, i) =>
          columns.has(i) ? `v.c${i}` : `CAST(NULL AS ${type(t)})`
        ))
      } FROM ${quote(name)} v`,
      types: input.types,
    };
  };
  const lowerView = (name: string): Lowered => {
    const cached = compiled.get(name);
    if (cached) return cached;
    require(plan[name] && name !== "error_view", "plan view");
    require(!active.has(name), "recursive view dependency");
    active.add(name);
    const nodes = new Map<number, Lowered>();
    for (const n of plan[name].rels) {
      require(!nodes.has(n.id), "duplicate node ID");
      const inputs = n.inputs.map((id) => {
        const v = nodes.get(id);
        require(v, "non-topological input");
        return v;
      });
      const unary = () => {
        require(inputs.length === 1, "unary operator");
        return inputs[0];
      };
      const common = ["id", "relOp", "inputs"];
      let lowered: Lowered;
      if (n.relOp === "LogicalTableScan") {
        keys(n, [...common, "table"]);
        require(
          inputs.length === 0 && n.table?.length === 2 &&
            n.table[0] === "schema",
          "base table scan",
        );
        const t = schema.inputs.find((t) => t.name === n.table![1]);
        lowered = t
          ? {
            sql: `${select(t.fields.map((f) => quote(f.name)))} FROM ${
              quote(t.name)
            }`,
            types: t.fields.map((f) => f.columntype),
          }
          : lowerView(n.table![1]);
      } else if (n.relOp === "LogicalValues") {
        keys(n, [...common, "type", "tuples"]);
        require(
          inputs.length === 0 && n.type && n.type.length > 0 && n.tuples,
          "typed literal rows",
        );
        const types = n.type.map((t) =>
          t.type === "CHAR" ? { ...t, type: "VARCHAR" } : t
        );
        types.forEach(type);
        const rows = n.tuples.map((tuple) => {
          require(tuple.length === types.length, "literal row width");
          return select(tuple.map((item, i) => {
            require("literal" in item, "literal row expression");
            const value = expression(item, [], []);
            require(type(value.type) === type(types[i]), "literal row type");
            return `CAST(${value.sql} AS ${type(types[i])})`;
          }));
        });
        lowered = {
          sql: rows.length
            ? rows.join(" UNION ALL ")
            : `${
              select(types.map((t) => `CAST(NULL AS ${type(t)})`))
            } WHERE FALSE`,
          types,
        };
      } else if (n.relOp === "LogicalUnion") {
        keys(n, [...common, "all"]);
        require(
          inputs.length >= 2 && typeof n.all === "boolean",
          "UNION inputs",
        );
        const types = inputs[0].types.map((t, i) => {
          require(
            inputs.every((input) =>
              input.types.length === inputs[0].types.length &&
              type(input.types[i]) === type(t)
            ),
            "UNION matching types",
          );
          return {
            ...t,
            nullable: inputs.some((input) => input.types[i].nullable),
          };
        });
        lowered = {
          sql: inputs.map((input) => `(${input.sql})`).join(
            n.all ? " UNION ALL " : " UNION ",
          ),
          types,
        };
      } else if (n.relOp === "LogicalProject") {
        keys(n, [...common, "fields", "exprs"]);
        const input = unary();
        require(
          n.exprs && n.fields?.length === n.exprs.length,
          "project expressions; compile with -v 1",
        );
        const items = n.exprs.map((e) =>
          expression(e, refs(input.types, "t"), input.types)
        );
        lowered = {
          sql: `${select(items.map((e) => e.sql))} FROM (${input.sql}) t`,
          types: items.map((e) => e.type),
        };
      } else if (n.relOp === "LogicalFilter") {
        keys(n, [...common, "condition"]);
        const input = unary();
        require(n.condition, "filter condition; compile with -v 1");
        lowered = {
          sql: `${select(refs(input.types, "t"))} FROM (${input.sql}) t WHERE ${
            expression(n.condition, refs(input.types, "t"), input.types).sql
          }`,
          types: input.types,
        };
      } else if (n.relOp === "LogicalAsofJoin") {
        keys(n, [...common, "condition", "joinType", "matchCondition"]);
        require(
          inputs.length === 2 && n.joinType === "left_asof" &&
            n.condition && n.matchCondition,
          "left ASOF join with equality and timestamp match",
        );
        const [l, r] = inputs;
        const inputTypes = [...l.types, ...r.types];
        const crossInputs = (e: Expression): [number, number] => {
          require(e.operands?.length === 2, "ASOF binary input comparison");
          const [a, b] = e.operands.map((operand) => operand.input);
          require(
            a !== undefined && b !== undefined && a < l.types.length &&
              b >= l.types.length,
            "ASOF comparison from left input to right input",
          );
          pick(inputTypes, a);
          pick(inputTypes, b);
          return [a, b];
        };
        const equalityKeys: [number, number][] = [];
        const equality = (e: Expression): void => {
          if (e.op?.name === "AND") {
            require(
              e.operands && e.operands.length >= 2,
              "ASOF equality conjunction",
            );
            e.operands.forEach(equality);
          } else {
            require(e.op?.name === "=", "ASOF equality keys");
            const [a, b] = crossInputs(e);
            require(
              type(inputTypes[a]) === type(inputTypes[b]),
              "ASOF matching key types",
            );
            equalityKeys.push([a, b - l.types.length]);
          }
        };
        equality(n.condition);
        require(
          n.matchCondition.op?.name === ">=",
          "ASOF greater-than-or-equal match",
        );
        const timeInputs = crossInputs(n.matchCondition);
        require(
          timeInputs.every((i) => inputTypes[i].type === "TIMESTAMP"),
          "ASOF timestamp match",
        );
        const columns = [...refs(l.types, "l"), ...refs(r.types, "r")];
        const join = (left: Lowered, right: Lowered): Lowered => ({
          sql: `${
            select(columns)
          } FROM (${left.sql}) l ASOF LEFT JOIN (${right.sql}) r ON ${
            expression(n.condition!, columns, inputTypes).sql
          } AND ${expression(n.matchCondition!, columns, inputTypes).sql}`,
          types: [
            ...l.types,
            ...r.types.map((t) => ({ ...t, nullable: true })),
          ],
        });
        if (physical) {
          // External ASOF sorting can exceed the bounded engine budget even after spilling.
          // Equal typed keys share a partition; null-key left rows still appear once.
          const scope = live!.get(name)!;
          const left = materialize(l, scope.live.get(n.inputs[0]) ?? new Set());
          const right = materialize(
            r,
            scope.live.get(n.inputs[1]) ?? new Set(),
          );
          const partition = (
            input: Lowered,
            side: 0 | 1,
            bucket: number,
          ): Lowered => ({
            sql: `${
              select(refs(input.types, "p"))
            } FROM (${input.sql}) p WHERE hash(${
              equalityKeys.map((key) => `p.c${key[side]}`).join(", ")
            }) % 64 = ${bucket}`,
            types: input.types,
          });
          const partitions = Array.from(
            { length: 64 },
            (_, bucket) =>
              materialize(
                join(partition(left, 0, bucket), partition(right, 1, bucket)),
                scope.live.get(n.id) ?? new Set(),
              ),
          );
          lowered = {
            sql: partitions.map((part) => part.sql).join(" UNION ALL "),
            types: partitions[0].types,
          };
        } else lowered = join(l, r);
      } else if (n.relOp === "LogicalJoin") {
        keys(n, [...common, "condition", "joinType"]);
        require(
          inputs.length === 2 && n.joinType &&
            ["inner", "left", "right", "full"].includes(n.joinType) &&
            n.condition,
          "ordinary join with condition",
        );
        const [l, r] = inputs;
        const types = [
          ...l.types.map((t) =>
            n.joinType === "right" || n.joinType === "full"
              ? { ...t, nullable: true }
              : t
          ),
          ...r.types.map((t) =>
            n.joinType === "left" || n.joinType === "full"
              ? { ...t, nullable: true }
              : t
          ),
        ];
        const columns = [...refs(l.types, "l"), ...refs(r.types, "r")];
        lowered = {
          sql: `${
            select(columns)
          } FROM (${l.sql}) l ${n.joinType.toUpperCase()} JOIN (${r.sql}) r ON ${
            expression(n.condition, columns, types).sql
          }`,
          types,
        };
      } else if (n.relOp === "LogicalAggregate") {
        keys(n, [...common, "group", "aggs"]);
        const input = unary();
        require(n.group && n.aggs, "aggregate calls; compile with -v 1");
        const columns = refs(input.types, "t");
        const groups = n.group.map((i) => pick(columns, i));
        const types = n.group.map((i) => pick(input.types, i));
        const items = n.aggs.map((a) => {
          keys(a, ["agg", "type", "distinct", "operands", "name"]);
          require(!a.distinct, "DISTINCT aggregate");
          require(
            ["COUNT", "SUM", "$SUM0", "MIN", "MAX", "AVG"].includes(a.agg.name),
            `aggregate ${a.agg.name}`,
          );
          if (a.agg.name === "AVG") {
            require(
              a.type.type === "DOUBLE" &&
                pick(input.types, a.operands[0]).type === "DOUBLE",
              "AVG DOUBLE only",
            );
          }
          if (a.agg.name === "SUM") {
            require(a.type.type !== "DECIMAL", "DECIMAL SUM");
          }
          if (a.agg.name === "$SUM0") {
            require(
              ["INTEGER", "BIGINT"].includes(a.type.type) &&
                ["INTEGER", "BIGINT"].includes(
                  pick(input.types, a.operands[0]).type,
                ),
              "SUM0 integer only",
            );
          }
          require(
            a.operands.length <= 1 &&
              (a.agg.name === "COUNT" || a.operands.length === 1),
            "aggregate arity",
          );
          types.push(a.type);
          const value = `${a.agg.name === "$SUM0" ? "SUM" : a.agg.name}(${
            a.operands.length ? pick(columns, a.operands[0]) : "*"
          })`;
          return `CAST(${
            a.agg.name === "$SUM0" ? `COALESCE(${value}, 0)` : value
          } AS ${type(a.type)})`;
        });
        const aggregate = (source: Lowered, predicate = ""): Lowered => ({
          sql: `${
            select([...groups, ...items])
          } FROM (${source.sql}) t${predicate}${
            groups.length ? ` GROUP BY ${groups.join(", ")}` : ""
          }`,
          types,
        });
        if (physical && groups.length) {
          // Partition complete groups, never partial accumulators: AVG, nulls and
          // integer overflow retain the ordinary aggregate's semantics.
          const scope = live!.get(name)!;
          const source = materialize(
            input,
            scope.live.get(n.inputs[0]) ?? new Set(),
          );
          const partitions = Array.from(
            { length: 16 },
            (_, bucket) =>
              materialize(
                aggregate(
                  source,
                  ` WHERE hash(${groups.join(", ")}) % 16 = ${bucket}`,
                ),
                scope.live.get(n.id) ?? new Set(),
              ),
          );
          lowered = {
            sql: partitions.map((part) => part.sql).join(" UNION ALL "),
            types,
          };
        } else lowered = aggregate(input);
      } else if (n.relOp === "LogicalTableFunctionScan") {
        keys(n, [...common, "invocation", "rowType"]);
        const input = unary();
        const call = n.invocation;
        require(
          call?.op && call.operands && ["HOP", "TUMBLE"].includes(call.op.name),
          "window function",
        );
        const args = call.operands;
        require(
          args.length === (call.op.name === "HOP" ? 3 : 2),
          "window offset",
        );
        const desc = args[0];
        require(
          desc.op?.name === "DESCRIPTOR" && desc.operands?.length === 1 &&
            desc.operands[0].input !== undefined,
          "timestamp descriptor",
        );
        const index = desc.operands[0].input;
        require(
          type(pick(input.types, index)) === "TIMESTAMP" &&
            !pick(input.types, index).nullable,
          "non-null TIMESTAMP window input",
        );
        const interval = (e: Expression) => {
          require(
            e.type &&
              [
                "INTERVAL_DAY",
                "INTERVAL_HOUR",
                "INTERVAL_MINUTE",
                "INTERVAL_SECOND",
              ].includes(e.type.type) && typeof e.literal === "number",
            "fixed interval literal",
          );
          const v = e.literal * 1000;
          require(
            Number.isSafeInteger(v) && v > 0 && v <= 86400000000,
            "window interval <= day",
          );
          return v;
        };
        const slide = interval(args[1]);
        const size = call.op.name === "HOP" ? interval(args[2]) : slide;
        require(
          size % slide === 0 && size / slide <= 100,
          "bounded integral HOP overlap",
        );
        require(
          n.rowType?.fields.length === input.types.length + 2,
          "window output shape",
        );
        const timestamp = `t.c${index}`;
        const epoch = `epoch_us(${timestamp})`;
        const floor =
          `(${epoch} - ((${epoch} % ${slide} + ${slide}) % ${slide}))`;
        lowered = {
          sql: `${
            select([
              ...refs(input.types, "w"),
              "make_timestamp(w.__start)",
              `make_timestamp(w.__start + ${size})`,
            ])
          } FROM (SELECT t.*, ${floor} - k.i * ${slide} AS __start FROM (${input.sql}) t CROSS JOIN range(${
            size / slide
          }) k(i) WHERE CASE WHEN isfinite(${timestamp}) THEN TRUE ELSE error('finite TIMESTAMP required') END) w`,
          types: n.rowType.fields,
        };
      } else throw new Error(`OUTSIDE_EXPORT_PROFILE: node ${n.relOp}`);
      if (
        physical &&
        ["LogicalJoin", "LogicalAsofJoin", "LogicalAggregate"].includes(n.relOp)
      ) {
        lowered = materialize(
          lowered,
          live!.get(name)!.live.get(n.id) ?? new Set(),
        );
      }
      nodes.set(n.id, lowered);
    }
    const last = plan[name].rels.at(-1);
    require(last, "empty plan");
    const root = nodes.get(last.id)!;
    if (physical) {
      const result = materialize(
        root,
        live!.get(name)!.live.get(last.id) ?? new Set(),
      );
      compiled.set(name, result);
      active.delete(name);
      return result;
    }
    let cte: string;
    do {
      cte = `__duckstream_${next++}`;
    } while (reserved.has(cte));
    reserved.add(cte);
    ctes.push(`${quote(cte)} AS (${root.sql})`);
    const result = {
      sql: `${select(refs(root.types, "v"))} FROM ${quote(cte)} v`,
      types: root.types,
    };
    compiled.set(name, result);
    active.delete(name);
    return result;
  };
  const root = lowerView(view);
  require(root.types.length === output.fields.length, "declared output width");
  output.fields.forEach((f, i) =>
    require(type(f.columntype) === type(root.types[i]), "declared output type")
  );
  return `${ctes.length ? `WITH ${ctes.join(",\n")}\n` : ""}SELECT ${
    output.fields.map((f, i) =>
      `CAST(result.c${i} AS ${type(f.columntype)}) AS ${quote(f.name)}`
    ).join(", ")
  } FROM (${root.sql}) result;\n`;
}
