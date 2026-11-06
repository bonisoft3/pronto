"""Isolated Feldera CDC experiment; run after compose up --wait."""
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
BASE = "http://127.0.0.1:18089"
NAME = "duckstream"


def api(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=data, method=method,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            text = response.read().decode()
    except HTTPError as error:
        raise RuntimeError(f"{method} {path}: {error.code}: {error.read().decode()}") from error
    return json.loads(text) if text else None


def pg(sql):
    return subprocess.run(
        ["docker", "compose", "-f", str(ROOT / "compose.yaml"), "exec", "-T", "postgres",
         "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "spike", "-At"],
        input=sql, text=True, check=True, capture_output=True).stdout


def program():
    tables = []
    for name, columns in [
        ("account", "id INTEGER NOT NULL PRIMARY KEY, label VARCHAR NOT NULL, revision INTEGER NOT NULL"),
        ("event", "id INTEGER NOT NULL PRIMARY KEY, account_id INTEGER NOT NULL, amount INTEGER NOT NULL, happened TIMESTAMP NOT NULL, revision INTEGER NOT NULL"),
    ]:
        connectors = json.dumps([{"name": "cdc", "transport": {"name": "postgres_cdc_input", "config": {
            "uri": "postgresql://postgres:spike@postgres:5432/spike",
            "publication": "duckstream", "source_table": "public." + name,
            "batch": {"max_fill_ms": 100},
        }}}])
        tables.append(f"CREATE TABLE {name} ({columns}) WITH ('materialized' = 'true', 'connectors' = '{connectors}');")
    return "\n".join(tables) + "\n" + (ROOT / "views.sql").read_text()


def wait_running(timeout=600, desired="Running"):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        state = api(f"/v0/pipelines/{NAME}")
        status = (state.get("program_status"), state.get("deployment_status"))
        if status != previous:
            print("pipeline", status, flush=True)
            previous = status
        if state.get("deployment_error") or state.get("program_status") in ("SqlError", "RustError", "SystemError"):
            raise RuntimeError(json.dumps({k: state[k] for k in ("program_status", "program_error", "deployment_error")}, indent=2))
        if state.get("deployment_status") == desired:
            return state
        time.sleep(1)
    raise TimeoutError(json.dumps(state, indent=2))


def query(sql):
    request = BASE + f"/v0/pipelines/{NAME}/query?" + urlencode({"sql": sql, "format": "json"})
    with urlopen(request, timeout=30) as response:
        return [json.loads(line) for line in response.read().decode().splitlines() if line]


def wait_rows(sql, expected, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = query(sql)
        if rows == expected:
            return rows
        time.sleep(.1)
    raise AssertionError(f"{sql}: expected {expected!r}, got {rows!r}")


def setup():
    pg((ROOT / "source.sql").read_text())
    api(f"/v0/pipelines/{NAME}", "PUT", {
        "name": NAME, "program_code": program(),
        "runtime_config": {"workers": 2, "storage": None, "max_parallel_connector_init": 1},
        "program_config": {"profile": "optimized"},
    })
    api(f"/v0/pipelines/{NAME}/start", "POST")
    wait_running()


def verify():
    evidence = {}
    sql = "SELECT id, total FROM totals ORDER BY id"
    evidence["bootstrap"] = wait_rows(sql, [{"id": 1, "total": 30}, {"id": 2, "total": 30}])
    evidence["tumble_boundaries"] = wait_rows(
        "SELECT CAST(window_start AS VARCHAR) AS start, CAST(window_end AS VARCHAR) AS stop, n, total FROM tumbling ORDER BY window_start",
        [{"start": "2026-01-01T00:00:00", "stop": "2026-01-01T00:00:05", "n": 2, "total": 30},
         {"start": "2026-01-01T00:00:05", "stop": "2026-01-01T00:00:10", "n": 1, "total": 30}])
    evidence["hop_overlap"] = wait_rows(
        "SELECT CAST(window_start AS VARCHAR) AS start, CAST(window_end AS VARCHAR) AS stop, n, total FROM hopping ORDER BY window_start",
        [{"start": "2025-12-31T23:59:55", "stop": "2026-01-01T00:00:05", "n": 2, "total": 30},
         {"start": "2026-01-01T00:00:00", "stop": "2026-01-01T00:00:10", "n": 3, "total": 60},
         {"start": "2026-01-01T00:00:05", "stop": "2026-01-01T00:00:15", "n": 1, "total": 30}])
    pg("INSERT INTO event VALUES (4, 1, 7, '2026-01-01 00:00:02', 0);")
    evidence["late_insert"] = wait_rows(sql, [{"id": 1, "total": 37}, {"id": 2, "total": 30}])
    pg("UPDATE event SET amount=12 WHERE id=4;")
    evidence["update"] = wait_rows(sql, [{"id": 1, "total": 42}, {"id": 2, "total": 30}])
    pg("DELETE FROM event WHERE id=4;")
    evidence["delete"] = wait_rows(sql, [{"id": 1, "total": 30}, {"id": 2, "total": 30}])

    stats = api(f"/v0/pipelines/{NAME}/stats")
    account_connector = next(x["endpoint_name"].split(".", 1)[1]
                             for x in stats["inputs"] if x["endpoint_name"].startswith("account."))
    account_path = f"/v0/pipelines/{NAME}/tables/account/connectors/{account_connector}"
    api(account_path + "/pause", "POST")
    pg("BEGIN; UPDATE account SET revision=1 WHERE id=1; UPDATE event SET revision=1 WHERE account_id=1; COMMIT;")
    revision_sql = "SELECT account_revision, event_revision FROM totals WHERE id=1"
    evidence["one_transaction_with_delayed_account_connector"] = wait_rows(
        revision_sql, [{"account_revision": 0, "event_revision": 1}])
    api(account_path + "/start", "POST")
    evidence["connectors_converge"] = wait_rows(
        revision_sql, [{"account_revision": 1, "event_revision": 1}])

    ingress = f"/v0/pipelines/{NAME}/ingress/timed?format=json&array=true"
    api(ingress, "POST", [{"insert": {"id": 1, "happened": "2026-01-01 00:00:00", "amount": 10}}])
    wait_rows("SELECT COUNT(*) AS n FROM timed", [{"n": 1}])
    before = query("SELECT n, total FROM final_windows ORDER BY window_start")
    time.sleep(6)
    after = query("SELECT n, total FROM final_windows ORDER BY window_start")
    assert before == after == [], (before, after)
    evidence["idle_six_seconds_does_not_close_event_time_window"] = after
    api(ingress, "POST", [{"insert": {"id": 2, "happened": "2026-01-01 00:00:20", "amount": 1}}])
    evidence["event_time_progress_closes_window"] = wait_rows(
        "SELECT n, total FROM final_windows ORDER BY window_start", [{"n": 1, "total": 10}])

    request = Request(BASE + f"/v0/pipelines/{NAME}/checkpoint", method="POST")
    try:
        with urlopen(request, timeout=30) as response:
            evidence["checkpoint_response"] = {"status": response.status, "body": response.read().decode()}
    except HTTPError as error:
        evidence["checkpoint_response"] = {"status": error.code, "body": error.read().decode()}
    checkpoint = evidence["checkpoint_response"]
    assert checkpoint["status"] == 501, checkpoint
    assert json.loads(checkpoint["body"])["error_code"] == "EnterpriseFeature", checkpoint
    assert json.loads(checkpoint["body"])["details"] == {"feature": "checkpoint"}, checkpoint

    api(f"/v0/pipelines/{NAME}/pause", "POST")
    wait_running(30, "Paused")
    pg("UPDATE event SET amount=11 WHERE id=1;")
    assert query(sql) == [{"id": 1, "total": 30}, {"id": 2, "total": 30}]
    api(f"/v0/pipelines/{NAME}/resume", "POST")
    wait_running(30)
    evidence["pause_resume"] = wait_rows(sql, [{"id": 1, "total": 31}, {"id": 2, "total": 30}])

    api(f"/v0/pipelines/{NAME}/stop?force=true", "POST")
    wait_running(30, "Stopped")
    api(f"/v0/pipelines/{NAME}/start", "POST")
    wait_running(60)
    pg("BEGIN; INSERT INTO account VALUES (3, 'after restart', 2); INSERT INTO event VALUES (5, 3, 50, '2026-01-01 00:00:30', 2); COMMIT;")
    evidence["restart_without_checkpoint_only_new_rows"] = wait_rows(sql, [{"id": 3, "total": 50}])
    evidence["source_rows_still_present"] = json.loads(pg(
        "SELECT json_agg(t ORDER BY id) FROM (SELECT account_id AS id, sum(amount) AS total FROM event GROUP BY account_id) t;"))
    assert evidence["source_rows_still_present"] == [{"id": 1, "total": 31}, {"id": 2, "total": 30}, {"id": 3, "total": 50}]
    (ROOT / "results.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2), flush=True)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "all"
    if command not in ("all", "setup", "verify"):
        raise SystemExit("usage: probe.py [all|setup|verify]")
    if command in ("all", "setup"):
        setup()
    if command in ("all", "verify"):
        verify()
