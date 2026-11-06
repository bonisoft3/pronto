package org.dbsp.sqlCompiler.compiler;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.calcite.plan.RelOptUtil;
import org.apache.calcite.rel.RelNode;
import org.apache.calcite.rel.core.*;
import org.apache.calcite.rel.type.RelDataType;
import org.apache.calcite.rex.*;
import org.apache.calcite.sql.*;
import org.apache.calcite.sql.type.SqlTypeName;
import org.apache.calcite.sql.util.SqlBasicVisitor;
import org.dbsp.sqlCompiler.compiler.frontend.parser.SqlCreateTable;
import org.dbsp.sqlCompiler.compiler.frontend.parser.SqlCreateView;
import org.dbsp.sqlCompiler.compiler.frontend.parser.SqlExtendedColumnDeclaration;

import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.IntStream;

public final class ContractPlanner {
    static final Set<SqlTypeName> WINDOW_INTERVAL_TYPES = Set.of(SqlTypeName.INTERVAL_DAY,
            SqlTypeName.INTERVAL_HOUR, SqlTypeName.INTERVAL_MINUTE, SqlTypeName.INTERVAL_SECOND);
    static IllegalArgumentException reject(String reason) {
        return new IllegalArgumentException("OUTSIDE_CONTRACT: " + reason);
    }

    static void require(boolean condition, String reason) {
        if (!condition) throw reject(reason);
    }

    static String quote(String value) {
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }

    static void admitName(Set<String> namespace, String name, String scope) {
        require(namespace.add(name.toLowerCase(Locale.ROOT)), "case-insensitive identifier collision in " + scope + ": " + name);
    }

    static String type(RelDataType type) {
        return switch (type.getSqlTypeName()) {
            case INTEGER -> "INTEGER";
            case BIGINT -> "BIGINT";
            case BOOLEAN -> "BOOLEAN";
            case VARCHAR -> "VARCHAR";
            case TIMESTAMP -> {
                require(type.getPrecision() == 6, "only TIMESTAMP(6)");
                yield "TIMESTAMP";
            }
            default -> throw reject("type " + type);
        };
    }

    static void admit(DBSPCompiler compiler, String source) throws Exception {
        int tables = 0, views = 0;
        var relations = new HashSet<String>();
        var allowedCalls = Set.of(
                "SELECT", "JOIN", "AS", "COUNT", "SUM", "=", "<>", "<", ">", "<=", ">=",
                "AND", "OR", "NOT", "IS NULL", "IS NOT NULL",
                "TUMBLE", "HOP", "DESCRIPTOR", "COLLECTION_TABLE", "EXPLICIT_TABLE", "TABLE");
        for (var parsed : compiler.sqlToRelCompiler.parseStatements(source)) {
            if (parsed.statement() instanceof SqlCreateTable table) {
                tables++;
                require(table.name.isSimple(), "simple table identifier");
                admitName(relations, table.name.getSimple(), "relations");
                require(table.tableProperties == null || table.tableProperties.isEmpty(),
                        "table properties (including append_only/connectors)");
                require(table.columnsOrForeignKeys != null, "columns required");
                var columns = new HashSet<String>();
                for (var item : table.columnsOrForeignKeys) {
                    require(item instanceof SqlExtendedColumnDeclaration, "only inline column declarations");
                    var column = (SqlExtendedColumnDeclaration) item;
                    admitName(columns, column.name.getSimple(), "table columns");
                    require(column.lateness == null, "LATENESS");
                    require(column.defaultValue == null && column.expression == null, "column defaults/generated values");
                    require(!column.interned && column.foreignKeyTables.isEmpty(), "interning/foreign keys");
                    var columnType = compiler.sqlToRelCompiler.specToRel(column.dataType, true);
                    type(columnType);
                    if (columnType.getSqlTypeName() == SqlTypeName.TIMESTAMP)
                        require(Boolean.FALSE.equals(column.dataType.getNullable()), "non-null timestamp");
                }
            } else if (parsed.statement() instanceof SqlCreateView view) {
                views++;
                require(view.name.isSimple() && view.name.getSimple().equalsIgnoreCase("result"), "one result view");
                admitName(relations, view.name.getSimple(), "relations");
                require(view.viewKind == SqlCreateView.ViewKind.STANDARD, "only ordinary views");
                require(view.viewProperties == null || view.viewProperties.isEmpty(), "view properties (including emit_final)");
                require(view.columnList == null, "view column annotations");
                view.query.accept(new SqlBasicVisitor<Void>() {
                    @Override public Void visit(SqlCall call) {
                        String name = call.getOperator().getName().toUpperCase(Locale.ROOT);
                        require(allowedCalls.contains(name), "SQL call " + name + " (NOW/UDF/recursion not admitted)");
                        require(call.getFunctionQuantifier() == null, "aggregate modifiers");
                        if (name.equals("TUMBLE") || name.equals("HOP")) {
                            require(call.getOperandList().size() == (name.equals("TUMBLE") ? 3 : 4),
                                    "window offsets not admitted");
                            for (int i = 2; i < call.getOperandList().size(); i++) {
                                require(call.getOperandList().get(i) instanceof SqlIntervalLiteral, "literal window interval");
                                var literal = ((SqlIntervalLiteral) call.getOperandList().get(i))
                                        .getValueAs(SqlIntervalLiteral.IntervalValue.class);
                                require(WINDOW_INTERVAL_TYPES.contains(literal.getIntervalQualifier().typeName()),
                                        "fixed day/hour/minute/second interval");
                                var value = new BigDecimal(literal.getIntervalLiteral());
                                require(literal.getSign() > 0 && value.signum() > 0
                                        && value.stripTrailingZeros().scale() <= 0, "positive whole-number window interval");
                            }
                        }
                        return super.visit(call);
                    }
                });
            } else {
                throw reject("statement " + parsed.statement().getClass().getSimpleName()
                        + " (LATENESS/UDF/recursion not admitted)");
            }
        }
        require(tables >= 1 && views == 1, "one result view and at least one table");
    }

    static List<String> refs(RelNode node, String alias) {
        return IntStream.range(0, node.getRowType().getFieldCount())
                .mapToObj(i -> alias + ".c" + i).toList();
    }

    static String select(List<String> expressions) {
        return "SELECT " + String.join(", ", IntStream.range(0, expressions.size())
                .mapToObj(i -> expressions.get(i) + " AS c" + i).toList());
    }

    static String expr(RexNode rex, List<String> refs) {
        type(rex.getType());
        if (rex instanceof RexInputRef ref) return refs.get(ref.getIndex());
        if (rex instanceof RexLiteral literal) {
            if (literal.isNull()) return "CAST(NULL AS " + type(literal.getType()) + ")";
            return switch (literal.getType().getSqlTypeName()) {
                case INTEGER, BIGINT -> literal.getValueAs(BigDecimal.class).toBigIntegerExact().toString();
                case BOOLEAN -> literal.getValueAs(Boolean.class) ? "TRUE" : "FALSE";
                case VARCHAR -> "'" + literal.getValueAs(String.class).replace("'", "''") + "'";
                default -> throw reject("literal " + literal);
            };
        }
        require(rex instanceof RexCall, "expression " + rex.getClass().getSimpleName());
        var call = (RexCall) rex;
        var args = call.getOperands().stream().map(arg -> expr(arg, refs)).toList();
        var op = call.getOperator().getName().toUpperCase(Locale.ROOT);
        if (Set.of("=", "<>", "<", ">", "<=", ">=", "AND", "OR").contains(op)) {
            require(args.size() >= 2, "binary/boolean arity");
            return "(" + String.join(" " + op + " ", args) + ")";
        }
        if (Set.of("IS NULL", "IS NOT NULL").contains(op) && args.size() == 1)
            return "(" + args.get(0) + " " + op + ")";
        if (op.equals("NOT") && args.size() == 1) return "(NOT " + args.get(0) + ")";
        throw reject("typed expression " + op);
    }

    static long interval(RexNode node) {
        require(node instanceof RexLiteral, "literal window interval");
        require(WINDOW_INTERVAL_TYPES.contains(node.getType().getSqlTypeName()), "fixed day/hour/minute/second interval");
        long micros = ((RexLiteral) node).getValueAs(BigDecimal.class).multiply(BigDecimal.valueOf(1000)).longValueExact();
        require(micros > 0 && micros <= 86_400_000_000L, "positive window interval <= one day");
        return micros;
    }

    static String lower(RelNode node) {
        node.getRowType().getFieldList().forEach(field -> type(field.getType()));
        if (node instanceof TableScan scan) {
            var names = scan.getTable().getQualifiedName();
            require(names.size() == 2 && names.get(0).equals("schema"), "local base table");
            var cols = scan.getRowType().getFieldNames().stream().map(ContractPlanner::quote).toList();
            return select(cols) + " FROM " + quote(names.get(1));
        }
        if (node instanceof Project project) {
            var cols = project.getProjects().stream().map(r -> expr(r, refs(project.getInput(), "t"))).toList();
            return select(cols) + " FROM (" + lower(project.getInput()) + ") t";
        }
        if (node instanceof Filter filter) {
            var refs = refs(filter.getInput(), "t");
            return select(refs) + " FROM (" + lower(filter.getInput()) + ") t WHERE " + expr(filter.getCondition(), refs);
        }
        if (node instanceof Join join) {
            require(join.getJoinType() == JoinRelType.INNER, "only inner joins");
            var refs = new ArrayList<>(refs(join.getLeft(), "l"));
            refs.addAll(refs(join.getRight(), "r"));
            return select(refs) + " FROM (" + lower(join.getLeft()) + ") l JOIN ("
                    + lower(join.getRight()) + ") r ON " + expr(join.getCondition(), refs);
        }
        if (node instanceof Aggregate aggregate) {
            require(aggregate.getGroupSets().size() == 1, "grouping sets");
            var refs = refs(aggregate.getInput(), "t");
            var keys = aggregate.getGroupSet().asList().stream().map(refs::get).toList();
            var cols = new ArrayList<>(keys);
            for (var call : aggregate.getAggCallList()) {
                String op = call.getAggregation().getName().toUpperCase(Locale.ROOT);
                require(Set.of("COUNT", "SUM").contains(op), "aggregate " + op);
                require(!call.isDistinct() && !call.isApproximate() && !call.ignoreNulls()
                        && !call.hasFilter() && !call.hasCollation() && call.rexList.isEmpty()
                        && call.distinctKeys == null, "aggregate modifiers");
                require(call.getArgList().size() <= 1 && (op.equals("COUNT") || call.getArgList().size() == 1),
                        "aggregate arity");
                var args = call.getArgList().stream().map(refs::get).toList();
                cols.add("CAST(" + op + "(" + (args.isEmpty() ? "*" : args.get(0)) + ") AS "
                        + type(call.getType()) + ")");
            }
            return select(cols) + " FROM (" + lower(aggregate.getInput()) + ") t"
                    + (keys.isEmpty() ? "" : " GROUP BY " + String.join(", ", keys));
        }
        if (node instanceof TableFunctionScan scan) {
            require(scan.getInputs().size() == 1 && scan.getCall() instanceof RexCall, "window table function");
            var call = (RexCall) scan.getCall();
            String op = call.getOperator().getName().toUpperCase(Locale.ROOT);
            require(Set.of("TUMBLE", "HOP").contains(op), "table function " + op);
            var args = call.getOperands();
            require(args.size() == (op.equals("TUMBLE") ? 2 : 3), "window offsets not admitted");
            require(args.get(0) instanceof RexCall, "timestamp descriptor");
            var descriptor = (RexCall) args.get(0);
            require(descriptor.getOperator().getName().equals("DESCRIPTOR")
                    && descriptor.getOperands().size() == 1
                    && descriptor.getOperands().get(0) instanceof RexInputRef, "single timestamp descriptor");
            var ref = (RexInputRef) descriptor.getOperands().get(0);
            var input = scan.getInput(0);
            var tsType = input.getRowType().getFieldList().get(ref.getIndex()).getType();
            require(tsType.getSqlTypeName() == SqlTypeName.TIMESTAMP && !tsType.isNullable(), "non-null timestamp");
            long slide = interval(args.get(1));
            long size = op.equals("TUMBLE") ? slide : interval(args.get(2));
            require(size % slide == 0 && size / slide <= 100, "HOP size must be a slide multiple with <=100 memberships");
            var cols = new ArrayList<>(refs(input, "w"));
            int width = cols.size();
            require(scan.getRowType().getFieldCount() == width + 2, "window output shape");
            cols.add("make_timestamp(w.__start)");
            cols.add("make_timestamp(w.__start + " + size + ")");
            // Integer remainder supplies floor for negative epochs without floating point rounding.
            String timestamp = "t.c" + ref.getIndex();
            String epoch = "epoch_us(" + timestamp + ")";
            String floor = "(" + epoch + " - ((" + epoch + " % " + slide + " + " + slide + ") % " + slide + "))";
            return select(cols) + " FROM (SELECT t.*, " + floor + " - k.i * " + slide
                    + " AS __start FROM (" + lower(input) + ") t CROSS JOIN range("
                    + size / slide + ") k(i) WHERE CASE WHEN isfinite(" + timestamp
                    + ") THEN TRUE ELSE error('OUTSIDE_CONTRACT: finite TIMESTAMP required') END) w";
        }
        throw reject("relational node " + node.getClass().getSimpleName());
    }

    public static void main(String[] args) throws Exception {
        require(args.length == 2, "source.sql output-directory");
        var output = Path.of(args[1]);
        Files.createDirectories(output);
        Files.deleteIfExists(output.resolve("duckdb.sql"));
        Files.deleteIfExists(output.resolve("rel.txt"));
        Files.deleteIfExists(output.resolve("typed-plan.json"));
        var options = new CompilerOptions();
        options.languageOptions.throwOnError = true;
        var compiler = new DBSPCompiler(options);
        String source = Files.readString(Path.of(args[0]));
        admit(new DBSPCompiler(options), source);
        compiler.submitStatementsForCompilation(source);
        require(compiler.getFinalCircuit(false) != null && !compiler.hasErrors(), compiler.messages.toString());
        var view = compiler.views.entrySet().stream().filter(entry -> entry.getKey().name().equals("result"))
                .findFirst().orElseThrow(() -> reject("missing result view")).getValue();
        var outputType = view.getRowType();
        var names = outputType.getFieldNames();
        var outputNames = new HashSet<String>();
        names.forEach(name -> admitName(outputNames, name, "view outputs"));
        // RelRoot preserves declared output aliases and mappings that optimized rel fields can lose.
        var rel = view.getRoot().project(true);
        require(rel.getRowType().getFieldCount() == outputType.getFieldCount(), "declared output width");
        for (int i = 0; i < outputType.getFieldCount(); i++) {
            var declared = outputType.getFieldList().get(i).getType();
            var actual = rel.getRowType().getFieldList().get(i).getType();
            require(type(declared).equals(type(actual)), "declared output type");
        }
        String body = lower(rel);
        String sql = "SELECT " + String.join(", ", IntStream.range(0, names.size())
                .mapToObj(i -> "result.c" + i + " AS " + quote(names.get(i))).toList())
                + " FROM (" + body + ") result;\n";
        Files.writeString(output.resolve("rel.txt"), RelOptUtil.toString(rel));
        Files.writeString(output.resolve("typed-plan.json"), new ObjectMapper().writerWithDefaultPrettyPrinter()
                .writeValueAsString(new TreeMap<>(Map.of("view", "result", "rowType", outputType.getFullTypeString(),
                        "backend", "bounded-contract-v1"))) + "\n");
        Files.writeString(output.resolve("duckdb.sql"), sql);
    }
}
