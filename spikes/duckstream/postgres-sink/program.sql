CREATE TABLE candidate (
    id INTEGER NOT NULL,
    version BIGINT NOT NULL,
    value BIGINT,
    deleted BOOLEAN NOT NULL,
    PRIMARY KEY (id, version)
) WITH ('materialized' = 'true');

CREATE LOCAL VIEW latest AS
SELECT id, MAX(version) AS version FROM candidate GROUP BY id;

CREATE MATERIALIZED VIEW authoritative WITH (
    'connectors' = '[{
        "name": "postgres",
        "index": "authoritative_key",
        "transport": {
            "name": "postgres_output",
            "config": {
                "uri": "postgresql://postgres:spike@postgres:5432/spike",
                "table": "authoritative",
                "mode": "materialized"
            }
        }
    }, {
        "name": "guarded_postgres",
        "index": "authoritative_key",
        "transport": {
            "name": "postgres_output",
            "config": {
                "uri": "postgresql://postgres:spike@postgres:5432/spike",
                "table": "guarded",
                "mode": "materialized"
            }
        }
    }]'
) AS
SELECT c.id, c.version, c.value, c.deleted
FROM candidate c JOIN latest l ON c.id = l.id AND c.version = l.version;

CREATE INDEX authoritative_key ON authoritative(id);
