WITH "__duckstream_0" AS (SELECT l.c0 AS c0, r.c0 AS c1 FROM (SELECT "id" AS c0 FROM "a") l FULL JOIN (SELECT "id" AS c0 FROM "b") r ON (l.c0 = r.c0))
SELECT CAST(result.c0 AS INTEGER) AS "a_id", CAST(result.c1 AS INTEGER) AS "b_id" FROM (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_0" v) result;
