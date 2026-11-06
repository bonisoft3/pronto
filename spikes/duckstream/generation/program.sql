CREATE TABLE candidate (
    scope VARCHAR NOT NULL,
    generation BIGINT NOT NULL,
    payload VARCHAR NOT NULL,
    digest VARCHAR NOT NULL,
    PRIMARY KEY (scope, generation)
) WITH ('materialized' = 'true');

CREATE LOCAL VIEW latest AS
SELECT scope, MAX(generation) AS generation FROM candidate GROUP BY scope;

CREATE MATERIALIZED VIEW complete_generation WITH (
    'connectors' = '[{
        "name": "postgres",
        "index": "generation_key",
        "transport": {
            "name": "postgres_output",
            "config": {
                "uri": "postgresql://native_writer:spike@postgres:5432/spike",
                "table": "generation_ingress",
                "mode": "materialized"
            }
        }
    }]'
) AS
SELECT c.scope, c.generation, c.payload, c.digest
FROM candidate c JOIN latest l ON c.scope = l.scope AND c.generation = l.generation;

CREATE INDEX generation_key ON complete_generation(scope);
