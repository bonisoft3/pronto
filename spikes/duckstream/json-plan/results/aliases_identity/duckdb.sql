WITH "__duckstream_0" AS (SELECT "x" AS c0, "y" AS c1 FROM "t")
SELECT CAST(result.c0 AS INTEGER) AS "renamed", CAST(result.c1 AS BIGINT) AS "Other" FROM (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_0" v) result;
