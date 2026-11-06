import datetime as dt
import json
import random
import subprocess

import duckdb

from generate import JAR, ROOT, generate

EPOCH = dt.datetime(1970, 1, 1)
SCHEMA = "CREATE TABLE events(id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT)"


def normalize(rows):
    return sorted([list(row) for row in rows], key=str)


def oracle(events, slide, size):
    groups = {}
    for _, timestamp, amount in events:
        delta = timestamp - EPOCH
        micros = delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + delta.microseconds
        latest = micros // slide * slide
        for start in range(latest - size + slide, latest + 1, slide):
            count, amounts = groups.setdefault(start, [0, []])
            groups[start][0] = count + 1
            if amount is not None:
                amounts.append(amount)
    return normalize([
        [EPOCH + dt.timedelta(microseconds=start), EPOCH + dt.timedelta(microseconds=start + size),
         count, sum(amounts) if amounts else None]
        for start, (count, amounts) in groups.items()
    ])


def main():
    assert duckdb.__version__ == "1.4.3", duckdb.__version__
    subprocess.run(["python3", str(ROOT / "generate.py")], check=True)
    output = ROOT / "results"
    sql = {name: (output / name / "duckdb.sql").read_text()
           for name in ("tumble", "hop", "aggregate", "join_aggregate")}
    cases = {
        "empty": [],
        "epoch_half_open": [
            (index, EPOCH + dt.timedelta(microseconds=value), amount)
            for index, (value, amount) in enumerate([
                (-10_000_001, 1), (-10_000_000, 2), (-5_000_001, 3), (-5_000_000, 4),
                (-1, 5), (0, 6), (1, 7), (4_999_999, 8), (5_000_000, 9),
                (9_999_999, 10), (10_000_000, 11), (10_000_001, 12),
            ])
        ],
        "nulls_and_duplicate_values": [
            (1, EPOCH, None), (2, EPOCH, None),
            (3, EPOCH + dt.timedelta(seconds=10), 7),
            (4, EPOCH + dt.timedelta(seconds=10), 7),
        ],
        "calendar_range": [(1, dt.datetime(1900, 1, 1), 2), (2, dt.datetime(2100, 1, 1), -4)],
    }
    rng = random.Random(83721)
    cases["deterministic_random"] = [
        (index, EPOCH + dt.timedelta(microseconds=rng.randrange(-10**12, 10**12)),
         None if index % 13 == 0 else rng.randrange(-1000000, 1000000))
        for index in range(250)
    ]
    results = {"duckdb": duckdb.__version__, "positive": {}, "negative": {}}
    with duckdb.connect() as db:
        db.execute("CREATE TABLE t(x INTEGER, y BIGINT)")
        db.execute("INSERT INTO t VALUES (3, 9007199254740993), (NULL, 7)")
        alias_sql = (output / "aliases/duckdb.sql").read_text()
        cursor = db.execute(alias_sql)
        assert [(column[0], str(column[1])) for column in cursor.description] == [
            ("renamed", "BIGINT"), ("Other", "INTEGER"), ("again", "INTEGER")
        ]
        assert normalize(cursor.fetchall()) == normalize([(9007199254740993, 3, 3), (7, None, None)])
        metadata = json.loads((output / "aliases/typed-plan.json").read_text())
        assert all(name in metadata["rowType"] for name in ("renamed", "Other", "again"))
        results["positive"]["declared_aliases_and_projection"] = {"status": "passed"}
        cursor = db.execute((output / "aliases_identity/duckdb.sql").read_text())
        assert [(column[0], str(column[1])) for column in cursor.description] == [
            ("renamed", "INTEGER"), ("Other", "BIGINT")
        ]
        assert normalize(cursor.fetchall()) == normalize([(3, 9007199254740993), (None, 7)])
        results["positive"]["identity_projection_aliases"] = {"status": "passed"}
    with duckdb.connect() as db:
        db.execute(SCHEMA)
        db.execute("CREATE TABLE accounts(id INTEGER PRIMARY KEY, region VARCHAR NOT NULL)")
        for name, rows in cases.items():
            db.execute("DELETE FROM events")
            db.execute("DELETE FROM accounts")
            if rows:
                db.executemany("INSERT INTO events VALUES (?, ?, ?)", rows)
                db.executemany("INSERT INTO accounts VALUES (?, ?)",
                               [(row[0], "even" if row[0] % 2 == 0 else "odd") for row in rows if row[0] % 3])
            for query, slide, size in (("tumble", 10_000_000, 10_000_000), ("hop", 5_000_000, 10_000_000)):
                actual = normalize(db.execute(sql[query]).fetchall())
                assert actual == oracle(rows, slide, size), (name, query, actual)
            values = [row[2] for row in rows if row[2] is not None]
            assert db.execute(sql["aggregate"]).fetchall() == [(len(rows), sum(values) if values else None)]
            expected_join = {}
            for ident, _, amount in rows:
                if ident % 3 and amount is not None and amount > 0:
                    region = "even" if ident % 2 == 0 else "odd"
                    count, total = expected_join.get(region, (0, 0))
                    expected_join[region] = count + 1, total + amount
            assert normalize(db.execute(sql["join_aggregate"]).fetchall()) == normalize(
                [(region, count, total) for region, (count, total) in expected_join.items()]
            )
            results["positive"][name] = {"rows": len(rows), "queries": 4, "status": "passed"}
        db.execute("DELETE FROM events")
        db.execute("INSERT INTO events VALUES (1, TIMESTAMP '1970-01-01', 9223372036854775807), "
                   "(2, TIMESTAMP '1970-01-01', 1)")
        try:
            db.execute(sql["aggregate"]).fetchall()
        except duckdb.ConversionException:
            results["positive"]["aggregate_overflow"] = {"status": "failed loudly as required"}
        else:
            raise AssertionError("BIGINT aggregate overflow must fail")
        db.execute("DELETE FROM events")
        db.execute("INSERT INTO events VALUES (1, TIMESTAMP 'infinity', 1)")
        for query_sql in [sql["tumble"], sql["hop"], (output / "window_count/duckdb.sql").read_text()]:
            try:
                db.execute(query_sql).fetchall()
            except duckdb.InvalidInputException as error:
                assert "finite TIMESTAMP required" in str(error)
            else:
                raise AssertionError("nonfinite timestamp must fail")
        results["positive"]["nonfinite_timestamp"] = {"status": "failed loudly as required"}

    source = (ROOT / "fixtures/tumble.sql").read_text()
    negatives = {
        "lateness": (source.replace("ts TIMESTAMP NOT NULL", "ts TIMESTAMP NOT NULL LATENESS INTERVAL '1' SECOND"), "LATENESS"),
        "emit_final": (source.replace("CREATE VIEW result AS", "CREATE VIEW result WITH ('emit_final' = 'window_end') AS"), "view properties"),
        "append_only": (source.replace("amount BIGINT);", "amount BIGINT) WITH ('append_only' = 'true');"), "table properties"),
        "now": (SCHEMA + "; CREATE VIEW result AS SELECT NOW() FROM events;", "SQL call NOW"),
        "udf_declaration": ("CREATE FUNCTION my_udf(x INTEGER) RETURNS INTEGER; " + source, "SqlCreateFunction"),
        "udf_call": (SCHEMA + "; CREATE VIEW result AS SELECT my_udf(id) FROM events;", "SQL call MY_UDF"),
        "recursion": ("DECLARE RECURSIVE VIEW r (id INTEGER); " + source, "statement"),
        "decimal": (source.replace("amount BIGINT", "amount DECIMAL(10,2)"), "type DECIMAL"),
        "timestamp_precision": (source.replace("ts TIMESTAMP", "ts TIMESTAMP(3)"), "TIMESTAMP(6)"),
        "nullable_timestamp": (source.replace("ts TIMESTAMP NOT NULL", "ts TIMESTAMP"), "non-null timestamp"),
        "hop_nonmultiple": (source.replace("TUMBLE(TABLE events, DESCRIPTOR(ts), INTERVAL '10' SECOND)",
                                             "HOP(TABLE events, DESCRIPTOR(ts), INTERVAL '6' SECOND, INTERVAL '10' SECOND)"), "slide multiple"),
        "window_offset": (source.replace("INTERVAL '10' SECOND)", "INTERVAL '10' SECOND, INTERVAL '1' SECOND)"), "window offsets"),
        "month_window": (source.replace("INTERVAL '10' SECOND", "INTERVAL '1' MONTH"), "fixed day/hour/minute/second"),
        "fractional_window": (source.replace("INTERVAL '10' SECOND", "INTERVAL '0.5' SECOND"), "whole-number"),
        "zero_window": (source.replace("INTERVAL '10' SECOND", "INTERVAL '0' SECOND"), "positive whole-number"),
        "window_too_large": (source.replace("INTERVAL '10' SECOND", "INTERVAL '2' DAY"), "<= one day"),
        "expression_arithmetic": (SCHEMA + "; CREATE VIEW result AS SELECT amount / 2 FROM events;", "SQL call /"),
        "aggregate_distinct": (source.replace("COUNT(*)", "COUNT(DISTINCT id)"), "aggregate modifiers"),
        "outer_join": ((ROOT / "fixtures/join_aggregate.sql").read_text().replace("JOIN accounts", "LEFT JOIN accounts"), "only inner joins"),
        "column_case_collision": ('CREATE TABLE t ("a" INTEGER, "A" INTEGER); '
                                  'CREATE VIEW result AS SELECT "a", "A" FROM t;', "collision in table columns"),
        "table_case_collision": ('CREATE TABLE "t" (x INTEGER); CREATE TABLE "T" (y INTEGER); '
                                 'CREATE VIEW result AS SELECT x FROM "t";', "collision in relations"),
        "view_table_case_collision": ('CREATE TABLE "RESULT" (x INTEGER); '
                                      'CREATE VIEW result AS SELECT x FROM "RESULT";', "collision in relations"),
        "output_case_collision": ('CREATE TABLE t (x INTEGER, y INTEGER); '
                                  'CREATE VIEW result AS SELECT x AS "a", y AS "A" FROM t;', "collision in view outputs"),
    }
    negative_root = output / "negative"
    negative_root.mkdir(exist_ok=True)
    for name, (text, expected) in negatives.items():
        fixture = negative_root / f"{name}.sql"
        fixture.write_text(text)
        target = negative_root / name
        target.mkdir(exist_ok=True)
        (target / "duckdb.sql").write_text("stale output must be removed")
        process = generate(fixture, target, JAR, output / "classes")
        diagnostic = process.stdout + process.stderr
        assert process.returncode != 0 and "OUTSIDE_CONTRACT:" in diagnostic and expected in diagnostic, (name, diagnostic)
        assert not (target / "duckdb.sql").exists(), name
        results["negative"][name] = {"status": "rejected before DuckDB execution", "reason": expected}
    (output / "tests.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
