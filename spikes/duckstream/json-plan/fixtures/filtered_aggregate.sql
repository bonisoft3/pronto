CREATE TABLE samples(x BIGINT, keep BOOLEAN);
CREATE VIEW result AS SELECT SUM(x) FILTER (WHERE keep) AS total FROM samples;
