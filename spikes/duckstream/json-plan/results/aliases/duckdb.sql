WITH "__duckstream_0" AS (SELECT t.c1 AS c0, t.c0 AS c1, t.c0 AS c2 FROM (SELECT "x" AS c0, "y" AS c1 FROM "t") t)
SELECT CAST(result.c0 AS BIGINT) AS "renamed", CAST(result.c1 AS INTEGER) AS "Other", CAST(result.c2 AS INTEGER) AS "again" FROM (SELECT v.c0 AS c0, v.c1 AS c1, v.c2 AS c2 FROM "__duckstream_0" v) result;
