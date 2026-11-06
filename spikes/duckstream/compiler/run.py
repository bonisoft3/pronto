import argparse
import hashlib
import json
import pathlib
import subprocess

import duckdb


ROOT = pathlib.Path(__file__).resolve().parent


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jar", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "results")
    args = parser.parse_args()
    jar = args.jar.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    assert duckdb.__version__ == "1.4.3", duckdb.__version__
    version = subprocess.run(
        ["java", "-jar", str(jar), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    assert "0.367.0" in version, version
    classes = output / "classes"
    classes.mkdir(exist_ok=True)
    subprocess.run(
        ["javac", "--release", "19", "-cp", str(jar), "-d", str(classes), str(ROOT / "DuckDBBridge.java")],
        check=True,
    )
    digest = hashlib.sha256()
    with jar.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    results = {
        "feldera": version,
        "jar_sha256": digest.hexdigest(),
        "duckdb": duckdb.__version__,
        "fixtures": {},
    }
    assert results["jar_sha256"] == "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab"
    for name in ("join_aggregate", "tumble", "hop"):
        target = output / name
        target.mkdir(exist_ok=True)
        for artifact in ("duckdb.sql", "typed-plan.json", "rel.txt", "rows.json", "duckdb-error.txt"):
            (target / artifact).unlink(missing_ok=True)
        process = subprocess.run(
            ["java", "-ea", "-cp", f"{classes}:{jar}",
             "org.dbsp.sqlCompiler.compiler.DuckDBBridge",
             str(ROOT / "fixtures" / f"{name}.sql"), str(target)],
            capture_output=True, text=True,
        )
        (target / "compiler.txt").write_text(process.stdout + process.stderr)
        if process.returncode:
            results["fixtures"][name] = {
                "status": "converter_rejected" if (target / "typed-plan.json").exists() else "frontend_rejected",
                "compiler_exit": process.returncode,
            }
            continue
        with duckdb.connect() as connection:
            connection.execute((ROOT / "fixtures" / "data.sql").read_text())
            try:
                cursor = connection.execute((target / "duckdb.sql").read_text())
                schema = [[column[0], str(column[1])] for column in cursor.description]
                rows = cursor.fetchall()
            except duckdb.Error as error:
                (target / "duckdb-error.txt").write_text(str(error) + "\n")
                results["fixtures"][name] = {"status": "duckdb_rejected", "error": str(error)}
                continue
        normalized = sorted([list(row) for row in rows], key=str)
        (target / "rows.json").write_text(json.dumps(normalized, indent=2, default=str) + "\n")
        results["fixtures"][name] = {"status": "executed", "rows": normalized, "schema": schema}
    (output / "summary.json").write_text(json.dumps(results, indent=2, default=str) + "\n")
    print(json.dumps(results, indent=2, default=str))
    assert results["fixtures"]["join_aggregate"]["status"] == "executed"
    assert results["fixtures"]["join_aggregate"]["rows"] == [["north", 3, 37], ["south", 1, 5]]
    for name in ("tumble", "hop"):
        assert results["fixtures"][name]["status"] == "duckdb_rejected"
        assert 'syntax error at or near "TABLE"' in results["fixtures"][name]["error"]


if __name__ == "__main__":
    run()
