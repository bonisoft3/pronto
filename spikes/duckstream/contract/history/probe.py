import argparse
from collections import Counter
from contextlib import contextmanager
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import tempfile
import time
import uuid

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent
IMAGE = 'postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8'
EXTENSION_HASHES = {
    'osx_arm64': 'cbc12698896b53bde2abd71d7cdfcf1fe1a49951a1c5e2552a3900e37541fa8c',
    'linux_amd64': '66b7b2b53ee3d0fcbb7f63b73cfb588a520d90e9f432241c477b0d1c7aae5161',
    'linux_arm64': '285e36ba5bcd374c2780dacfd5b4ccdf321b1e9cc3dbb55315f65a0825d487cc',
}
COLUMNS = {'events': ('id', 'ts', 'amount'), 'accounts': ('id', 'label')}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), default=str)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def command(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{args!r} exited {result.returncode}\n{result.stdout}\n{result.stderr}')
    return result.stdout.strip()


def extension():
    assert duckdb.__version__ == '1.4.3'
    with duckdb.connect() as c:
        platform = c.execute('PRAGMA platform').fetchone()[0]
    expected = EXTENSION_HASHES[platform]
    path = ROOT / '.cache' / platform / 'ducklake.duckdb_extension'
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        compressed = subprocess.run(['curl', '-fLsS', f'https://extensions.duckdb.org/v1.4.3/{platform}/ducklake.duckdb_extension.gz'], check=True, capture_output=True).stdout
        binary = gzip.decompress(compressed)
        assert hashlib.sha256(binary).hexdigest() == expected
        path.write_bytes(binary)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
    return path, platform, expected


class Source:
    def __init__(self):
        self.name = 'duckstream-contract-' + uuid.uuid4().hex[:12]

    def sql(self, sql):
        return command(['docker', 'exec', '-i', self.name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], input=sql)

    def scalar(self, sql):
        return self.sql(sql)

    def peek(self):
        rows = json.loads(self.sql("SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM pg_logical_slot_peek_changes('contract', NULL, NULL, 'skip-empty-xacts', '1') t"))
        transactions, current = [], None
        for row in rows:
            text = row['data']
            if text == 'BEGIN ' + row['xid']:
                assert current is None
                current = {'xid': row['xid'], 'changes': []}
            elif text == 'COMMIT ' + row['xid']:
                assert current is not None and current['xid'] == row['xid']
                current['lsn'] = row['lsn']
                transactions.append(current)
                current = None
            else:
                assert current is not None and current['xid'] == row['xid']
                current['changes'].append(row)
        assert current is None
        return transactions

    def ack(self, tx):
        consumed = json.loads(self.sql(f"SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM pg_logical_slot_get_changes('contract', {literal(tx['lsn'])}, NULL, 'skip-empty-xacts', '1') t"))
        assert consumed[-1]['data'] == 'COMMIT ' + tx['xid']

    def confirmed(self):
        return self.scalar("SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name='contract'")

    def __enter__(self):
        command(['docker', 'run', '-d', '--name', self.name, '-e', 'POSTGRES_PASSWORD=spike', '--tmpfs', '/var/lib/postgresql', IMAGE, '-c', 'wal_level=logical'])
        ready = False
        try:
            for _ in range(100):
                health = subprocess.run(['docker', 'exec', self.name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], capture_output=True)
                if health.returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError(command(['docker', 'logs', self.name]))
            self.sql('CREATE TABLE events(id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT); CREATE TABLE accounts(id INTEGER PRIMARY KEY, label TEXT NOT NULL);')
            self.sql("SELECT * FROM pg_create_logical_replication_slot('contract', 'test_decoding')")
            ready = True
            return self
        finally:
            if not ready:
                command(['docker', 'rm', '-f', self.name])

    def __exit__(self, *_):
        command(['docker', 'rm', '-f', self.name])


def decode(row):
    match = re.fullmatch(r'table public\.(events|accounts): (INSERT|UPDATE|DELETE): (.+)', row['data'])
    assert match, row
    table, operation, fields = match.groups()
    values, consumed = {}, 0
    for field in re.finditer(r"(\w+)\[([^\]]+)\]:(null|-?\d+|'(?:[^']|'')*')(?: |$)", fields):
        assert field.start() == consumed, fields
        consumed = field.end()
        name, kind, value = field.group(1, 2, 3)
        assert name in COLUMNS[table] and name not in values
        assert kind in ('integer', 'bigint', 'timestamp without time zone', 'text')
        values[name] = None if value == 'null' else value[1:-1].replace("''", "'") if value.startswith("'") else int(value)
    assert consumed == len(fields), fields
    assert set(values) == ({'id'} if operation == 'DELETE' else set(COLUMNS[table])), values
    return table, operation, values


class InjectedFailure(Exception):
    pass


@contextmanager
def transaction(c):
    c.execute('BEGIN')
    committed = False
    try:
        yield
        c.execute('COMMIT')
        committed = True
    finally:
        if not committed:
            c.execute('ROLLBACK')


class Lake:
    def __init__(self, directory, binary):
        self.directory, self.binary = directory, binary

    def connect(self, snapshot=None):
        c = duckdb.connect()
        c.execute('LOAD ' + literal(self.binary))
        assert c.execute("SELECT extension_version FROM duckdb_extensions() WHERE extension_name='ducklake'").fetchone()[0] == 'de813ff'
        options = f"DATA_PATH {literal(self.directory / 'data')}, DATA_INLINING_ROW_LIMIT 0"
        if snapshot is not None:
            options += f', SNAPSHOT_VERSION {int(snapshot)}'
        c.execute(f"ATTACH {literal('ducklake:' + str(self.directory / 'catalog.duckdb'))} AS lake ({options})")
        c.execute('USE lake')
        return c

    def initialize(self):
        with self.connect() as c, transaction(c):
            c.execute('CREATE TABLE events(id INTEGER, ts TIMESTAMP, amount BIGINT)')
            c.execute('CREATE TABLE accounts(id INTEGER, label VARCHAR)')
            c.execute('CREATE TABLE history(commit_lsn VARCHAR, ordinal INTEGER, xid VARCHAR, table_name VARCHAR, operation VARCHAR, before_json VARCHAR, after_json VARCHAR, raw_json VARCHAR)')
            c.execute('CREATE TABLE source_transactions(commit_lsn VARCHAR, payload_hash VARCHAR)')
            c.execute('CREATE TABLE source_cursor(commit_lsn VARCHAR)')
            c.execute("INSERT INTO source_cursor VALUES ('0/0')")
            c.execute('CREATE TABLE jobs(job_id VARCHAR, snapshot BIGINT, query_hash VARCHAR, source_lsn VARCHAR)')
            c.execute('CREATE TABLE sink(schedule VARCHAR, view_name VARCHAR, row_json VARCHAR)')
            c.execute('CREATE TABLE differences(job_id VARCHAR, schedule VARCHAR, view_name VARCHAR, row_json VARCHAR, weight BIGINT)')
            c.execute('CREATE TABLE receipts(job_id VARCHAR, schedule VARCHAR, view_name VARCHAR, snapshot BIGINT, result_hash VARCHAR)')

    def ingest(self, tx, fail=False):
        payload_hash = digest(encoded(tx))
        with self.connect() as c, transaction(c):
            old = c.execute('SELECT payload_hash FROM source_transactions WHERE commit_lsn=?', [tx['lsn']]).fetchall()
            if old:
                assert old == [(payload_hash,)], 'LSN replay changed its payload'
                return False
            previous = c.execute('SELECT commit_lsn FROM source_cursor').fetchone()[0]
            assert lsn_number(tx['lsn']) > lsn_number(previous)
            for ordinal, raw in enumerate(tx['changes']):
                table, operation, values = decode(raw)
                rows = c.execute(f'SELECT * FROM {table} WHERE id=?', [values['id']]).fetchall()
                assert len(rows) == (0 if operation == 'INSERT' else 1), (operation, rows)
                before = dict(zip(COLUMNS[table], rows[0])) if rows else None
                after = None if operation == 'DELETE' else values
                if operation != 'INSERT':
                    c.execute(f'DELETE FROM {table} WHERE id=?', [values['id']])
                if after is not None:
                    marks = ','.join('?' for _ in COLUMNS[table])
                    c.execute(f'INSERT INTO {table} VALUES ({marks})', [after[key] for key in COLUMNS[table]])
                c.execute('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)', [tx['lsn'], ordinal, tx['xid'], table, operation, encoded(before), encoded(after), encoded(raw)])
            if fail:
                raise InjectedFailure('before source cursor commit')
            c.execute('INSERT INTO source_transactions VALUES (?,?)', [tx['lsn'], payload_hash])
            c.execute('UPDATE source_cursor SET commit_lsn=?', [tx['lsn']])
        return True

    def snapshot(self):
        with self.connect() as c:
            return c.execute('SELECT max(snapshot_id) FROM lake.snapshots()').fetchone()[0]

    def rows(self, sql, snapshot=None, params=None):
        with self.connect(snapshot) as c:
            return c.execute(sql, params or []).fetchall()

    def job(self, name, snapshot, sql):
        source_lsn = self.rows('SELECT commit_lsn FROM source_cursor', snapshot)[0][0]
        with self.connect() as c:
            c.execute('INSERT INTO jobs VALUES (?,?,?,?)', [name, snapshot, digest(sql), source_lsn])

    def compute(self, name, sql):
        snapshot, query_hash = self.rows('SELECT snapshot,query_hash FROM jobs WHERE job_id=?', params=[name])[0]
        assert digest(sql) == query_hash
        return sorted(encoded(row) for row in self.rows(sql, snapshot))

    def publish(self, job, schedule, view, rows, fail=False):
        result_hash = digest(encoded(rows))
        with self.connect() as c, transaction(c):
            snapshot = c.execute('SELECT snapshot FROM jobs WHERE job_id=?', [job]).fetchone()[0]
            receipt = c.execute('SELECT schedule,view_name,snapshot,result_hash FROM receipts WHERE job_id=?', [job]).fetchall()
            if receipt:
                assert receipt == [(schedule, view, snapshot, result_hash)]
                return False
            previous = c.execute('SELECT max(snapshot) FROM receipts WHERE schedule=? AND view_name=?', [schedule, view]).fetchone()[0]
            assert previous is None or snapshot > previous, 'stale publication'
            old = Counter(row[0] for row in c.execute('SELECT row_json FROM sink WHERE schedule=? AND view_name=?', [schedule, view]).fetchall())
            new = Counter(rows)
            for row in sorted(old.keys() | new.keys()):
                weight = new[row] - old[row]
                if weight:
                    c.execute('INSERT INTO differences VALUES (?,?,?,?,?)', [job, schedule, view, row, weight])
            c.execute('DELETE FROM sink WHERE schedule=? AND view_name=?', [schedule, view])
            for row in rows:
                c.execute('INSERT INTO sink VALUES (?,?,?)', [schedule, view, row])
            if fail:
                raise InjectedFailure('before publication receipt')
            c.execute('INSERT INTO receipts VALUES (?,?,?,?,?)', [job, schedule, view, snapshot, result_hash])
        return True


def lsn_number(lsn):
    high, low = lsn.split('/')
    return (int(high, 16) << 32) + int(low, 16)


def expect_failure(action):
    try:
        action()
    except InjectedFailure:
        return
    raise AssertionError('fault injection did not fire')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--planner-results', type=pathlib.Path, default=ROOT.parent / 'planner' / 'results')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'results.json')
    args = parser.parse_args()
    queries = {name: (args.planner_results / name / 'duckdb.sql').read_text() for name in ('aggregate', 'tumble', 'hop')}
    expected = json.loads((ROOT / 'expected.json').read_text())
    binary, platform, extension_hash = extension()
    with tempfile.TemporaryDirectory(prefix='duckstream-contract-') as temp, Source() as source:
        lake = Lake(pathlib.Path(temp), binary)
        lake.initialize()
        initial_snapshot = lake.snapshot()
        source_version = source.scalar('SHOW server_version')
        source.sql("BEGIN; INSERT INTO events VALUES (1,'1969-12-31 23:59:59',7),(2,'1970-01-01 00:00:02',10),(3,'1970-01-01 00:00:07',20); INSERT INTO accounts VALUES (1,'initial'); COMMIT;")
        first, = source.peek()
        confirmed = source.confirmed()
        expect_failure(lambda: lake.ingest(first, fail=True))
        assert lake.snapshot() == initial_snapshot
        assert lake.rows('SELECT count(*) FROM history') == [(0,)]
        assert lake.rows('SELECT count(*) FROM events') == [(0,)]
        assert lake.rows('SELECT count(*) FROM accounts') == [(0,)]
        assert lake.rows('SELECT commit_lsn FROM source_cursor') == [('0/0',)]
        assert source.confirmed() == confirmed
        assert lake.ingest(first)
        first_snapshot = lake.snapshot()
        assert source.confirmed() == confirmed
        assert source.peek() == [first]
        assert not lake.ingest(first)
        assert lake.snapshot() == first_snapshot
        assert lake.rows('SELECT count(*) FROM history') == [(4,)]
        source.ack(first)
        assert source.peek() == []
        assert lsn_number(source.confirmed()) >= lsn_number(first['lsn'])
        first_results = {}
        for name, sql in queries.items():
            job = 'eager-first-' + name
            lake.job(job, first_snapshot, sql)
            first_results[name] = lake.compute(job, sql)
            assert first_results[name] == sorted(encoded(row) for row in expected['first'][name])
            assert lake.publish(job, 'eager', name, first_results[name])
        source.sql("BEGIN; UPDATE events SET amount=15 WHERE id=2; DELETE FROM events WHERE id=3; INSERT INTO events VALUES (4,'1970-01-01 00:00:12',5),(99,'1970-01-01 00:00:03',99); DELETE FROM events WHERE id=99; UPDATE accounts SET label='second' WHERE id=1; COMMIT;")
        second, = source.peek()
        assert lake.ingest(second)
        second_snapshot = lake.snapshot()
        source.ack(second)
        assert lake.rows('SELECT id,amount FROM events ORDER BY id', first_snapshot) == [(1,7),(2,10),(3,20)]
        assert lake.rows('SELECT label FROM accounts', first_snapshot) == [('initial',)]
        assert lake.rows('SELECT id,amount FROM events ORDER BY id', second_snapshot) == [(1,7),(2,15),(4,5)]
        assert lake.rows('SELECT label FROM accounts', second_snapshot) == [('second',)]
        assert lake.rows('SELECT count(*) FROM history') == [(10,)]
        assert lake.rows("SELECT operation FROM history WHERE after_json LIKE '%\"id\":99%' OR before_json LIKE '%\"id\":99%' ORDER BY ordinal") == [('INSERT',),('DELETE',)]
        assert lake.rows('SELECT count(DISTINCT commit_lsn) FROM history') == [(2,)]
        update_before, update_after = lake.rows("SELECT before_json,after_json FROM history WHERE table_name='events' AND operation='UPDATE'")[0]
        assert json.loads(update_before)['amount'] == 10 and json.loads(update_after)['amount'] == 15
        assert lake.rows('SELECT commit_lsn FROM source_cursor', first_snapshot) == [(first['lsn'],)]
        assert lake.rows('SELECT commit_lsn FROM source_cursor', second_snapshot) == [(second['lsn'],)]
        final_results = {}
        publication_rollback = False
        for name, sql in queries.items():
            assert lake.compute('eager-first-' + name, sql) == first_results[name]
            for schedule in ('eager', 'coalesced'):
                job = schedule + '-second-' + name
                lake.job(job, second_snapshot, sql)
                rows = lake.compute(job, sql)
                assert rows == sorted(encoded(row) for row in expected['final'][name])
                final_results[name] = rows
                before = {table: lake.rows(f'SELECT * FROM {table} ORDER BY ALL') for table in ('sink','differences','receipts')}
                expect_failure(lambda: lake.publish(job, schedule, name, rows, fail=True))
                assert before == {table: lake.rows(f'SELECT * FROM {table} ORDER BY ALL') for table in before}
                publication_rollback = True
                assert lake.publish(job, schedule, name, rows)
                assert not lake.publish(job, schedule, name, rows)
            assert lake.rows('SELECT row_json FROM sink WHERE schedule=? AND view_name=? ORDER BY row_json', params=['eager',name]) == lake.rows('SELECT row_json FROM sink WHERE schedule=? AND view_name=? ORDER BY row_json', params=['coalesced',name])
        source_rows = json.loads(source.sql('SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM events ORDER BY id) t'))
        assert [(row['id'],row['amount']) for row in source_rows] == lake.rows('SELECT id,amount FROM events ORDER BY id')
        counts = dict(lake.rows('SELECT schedule,count(*) FROM receipts GROUP BY schedule'))
        assert counts == {'eager': 6, 'coalesced': 3}
        assert lake.rows('SELECT count(*) FROM differences WHERE weight < 0')[0][0] > 0
        for schedule in ('eager', 'coalesced'):
            for name in queries:
                differences = dict(lake.rows('SELECT row_json,sum(weight)::BIGINT FROM differences WHERE schedule=? AND view_name=? GROUP BY row_json HAVING sum(weight) != 0', params=[schedule,name]))
                assert differences == dict(Counter(final_results[name]))
        snapshots = lake.rows('SELECT snapshot_id FROM lake.snapshots() ORDER BY snapshot_id')
        parquet_files = list((pathlib.Path(temp) / 'data').rglob('*.parquet'))
        assert parquet_files
        result = {
            'status': 'passed', 'duckdb': duckdb.__version__, 'ducklake': 'de813ff',
            'extension_platform': platform, 'extension_sha256': extension_hash,
            'postgres': source_version, 'postgres_image': IMAGE,
            'source': 'live PostgreSQL logical slot; fixed-schema test_decoding adapter',
            'storage': 'real DuckLake; local DuckDB metadata and retained data files',
            'execution': 'full relation recompute over pinned snapshot',
            'publication': 'DuckLake transactional test sink; not PostgreSQL Airlock integration',
            'snapshots': {'initial': initial_snapshot, 'first': first_snapshot, 'second': second_snapshot, 'retained_count': len(snapshots)},
            'source_transactions': 2, 'retained_changes': 10, 'receipt_counts': counts,
            'parquet_files': len(parquet_files),
            'query_sha256': {name: digest(sql) for name,sql in queries.items()},
            'first_results': {name: [json.loads(row) for row in rows] for name,rows in first_results.items()},
            'final_results': {name: [json.loads(row) for row in rows] for name,rows in final_results.items()},
            'assertions': {
                'source_cursor_base_history_atomic': True,
                'source_ack_after_commit': True,
                'lost_ack_replay_deduplicated': True,
                'reopen_pinned_snapshot_after_newer_commit': True,
                'multitable_source_cut': True,
                'transient_insert_delete_retained': True,
                'publication_diff_receipt_atomic': publication_rollback,
                'lost_publication_ack_deduplicated': True,
                'refresh_schedules_same_final_relation': True,
                'independent_expected_relations': True,
            },
        }
        args.output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
