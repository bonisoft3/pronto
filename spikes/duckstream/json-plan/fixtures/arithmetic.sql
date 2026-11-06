CREATE TABLE numbers(i INTEGER, n BIGINT, d DOUBLE);
CREATE VIEW result AS
SELECT i + 2 AS added, i - 3 AS subtracted, i * 4 AS multiplied,
       n + CAST(1 AS BIGINT) AS exact_plus, d + CAST(0.125 AS DOUBLE) AS fractional,
       CAST(i AS DOUBLE) AS floating
FROM numbers;
