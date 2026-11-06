package org.dbsp.sqlCompiler.compiler;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.calcite.plan.RelOptUtil;
import org.apache.calcite.rel.rel2sql.RelToSqlConverter;
import org.apache.calcite.sql.dialect.DuckDBSqlDialect;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;

public final class DuckDBBridge {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("Expected source.sql output-directory");
        }
        var output = Path.of(args[1]);
        Files.createDirectories(output);
        var options = new CompilerOptions();
        options.languageOptions.throwOnError = true;
        var compiler = new DBSPCompiler(options);
        compiler.submitStatementsForCompilation(Files.readString(Path.of(args[0])));
        if (compiler.getFinalCircuit(false) == null || compiler.hasErrors()) {
            throw new IllegalStateException(compiler.messages.toString());
        }
        var mapper = new ObjectMapper();
        var metadata = new LinkedHashMap<String, Object>();
        for (var entry : compiler.views.entrySet()) {
            var name = entry.getKey().name();
            if (!name.equals("result")) {
                continue;
            }
            var rel = entry.getValue().getRel();
            Files.writeString(output.resolve("rel.txt"), RelOptUtil.toString(rel));
            metadata.put("view", name);
            metadata.put("rowType", rel.getRowType().getFullTypeString());
            Files.writeString(output.resolve("typed-plan.json"),
                    mapper.writerWithDefaultPrettyPrinter().writeValueAsString(metadata));
            var dialect = DuckDBSqlDialect.DEFAULT;
            var sql = new RelToSqlConverter(dialect).visitRoot(rel).asStatement()
                    .toSqlString(dialect).getSql();
            Files.writeString(output.resolve("duckdb.sql"), sql + ";\n");
        }
        if (!metadata.containsKey("view")) {
            throw new IllegalStateException("Required view result was not compiled");
        }
    }
}
