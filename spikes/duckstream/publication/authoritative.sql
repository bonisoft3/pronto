CREATE TABLE candidates (
    output_key INTEGER NOT NULL,
    input_version BIGINT NOT NULL,
    value INTEGER NOT NULL,
    deleted BOOLEAN NOT NULL,
    PRIMARY KEY (output_key, input_version)
);
CREATE VIEW result AS
WITH latest AS (
    SELECT output_key, MAX(input_version) AS input_version
    FROM candidates GROUP BY output_key
)
SELECT c.output_key, c.input_version, c.value, c.deleted
FROM candidates c JOIN latest l
ON c.output_key = l.output_key AND c.input_version = l.input_version;
