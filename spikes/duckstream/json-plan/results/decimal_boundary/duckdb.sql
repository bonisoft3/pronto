WITH "__duckstream_0" AS (SELECT "amount" AS c0 FROM "money")
SELECT CAST(result.c0 AS DECIMAL(28,8)) AS "amount" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
