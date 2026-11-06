SELECT "t1"."region", COUNT(*) AS "order_count", SUM("t0"."amount") AS "total"
FROM (SELECT *
FROM "schema"."orders"
WHERE "amount" > 0) AS "t0"
INNER JOIN "schema"."customers" AS "t1" ON "t0"."customer_id" = "t1"."id"
GROUP BY "t1"."region";
