# Feldera → Calcite → DuckDB compiler probe

Feldera 0.367.0's actual typed `RelNode` can feed stock Calcite
`RelToSqlConverter(DuckDBSqlDialect.DEFAULT)`. The ordinary join/filter/grouped
aggregate fixture runs unchanged in native DuckDB and browser DuckDB-WASM.
TUMBLE and HOP remain SQL table functions and fail in both DuckDB parsers.

| Fixture | Feldera frontend | Stock SQL conversion | Native 1.4.3 | Browser engine 1.5.4 |
| --- | --- | --- | --- | --- |
| Join + aggregate | Pass | Pass | Expected rows | Expected rows |
| TUMBLE | Pass | Pass | Parser rejects `TABLE` | Parser rejects `TABLE` |
| HOP | Pass | Pass | Parser rejects `TABLE` | Parser rejects `TABLE` |

The ordinary rows are `north, 3, 37` and `south, 1, 5`. Value agreement on this
fixture does **not** establish type equivalence: Feldera declares the total
`BIGINT`, native DuckDB returns `HUGEINT`, and WASM exposes it as Arrow Decimal128.
The browser harness decodes that Arrow value for comparison without changing SQL.

[[../DuckDBBridge.java]] accesses package-private `DBSPCompiler.views` by living
in Feldera's package. This is compiler implementation coupling, not a public
interchange API. It runs `getFinalCircuit(false)` to populate views, including
Feldera's DBSP compilation stages; the probe does not yet extract a frontend-only
service. Diagnostic plan JSON is never deserialized or used as executable IR.
The target catalog creates Feldera's emitted `schema` namespace.

Stock-rule inspection in [[../results/window-rule-inspection.txt]] found window
optimization rules and enumerable table-function support, but no TUMBLE/HOP
rewrite into portable relational operations. The enumerable implementations
generate Java/linq4j calls to `TUMBLING` and `HOPPING`; switching to those is not
DuckDB SQL lowering. A general bridge would need explicit typed lowering and
semantic tests for windows, widths, overflow, nullability, timestamps, and
Feldera-specific operators. No such lowering is implemented here.

[[../results/summary.json]] and [[../results/browser.json]] record actual engines,
schemas, rows and failures. Per-fixture folders retain the typed plan, relational
plan, untouched emitted SQL and compiler diagnostics. The compiler jar hash is
asserted by [[../run.py]]; [[../extract-jar.sh]] pins the container digest and only
creates a stopped extraction container, which it removes.

Run from the repository root with JDK 19+ and Python 3.9+:

```sh
cd plugins/pronto/spikes/duckstream/compiler
bash extract-jar.sh
python3 -m venv .cache/venv
.cache/venv/bin/pip install -r requirements.txt
.cache/venv/bin/python run.py --jar .cache/feldera-0.367.0.jar
bash inspect-rules.sh .cache/feldera-0.367.0.jar > results/window-rule-inspection.txt
npm ci
npx playwright install chromium
node browser.mjs
```

The browser runner serves only bundled dependency assets on an ephemeral loopback
port and runs Chromium headlessly. It pins DuckDB-WASM 1.33.1-dev57.0, Playwright
1.59.1 and esbuild 0.27.2. Its EH worker reports DuckDB v1.5.4, so this is a
cross-engine-version smoke test, not a native/WASM version parity claim. Both
runners assert the observed unsupported window cases; their successful exit
means the probe reproduced those limits, not that windows work.
