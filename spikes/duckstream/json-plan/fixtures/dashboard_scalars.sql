CREATE TABLE scalar_inputs (
  id INTEGER NOT NULL, amount BIGINT,
  haystack VARCHAR, needle VARCHAR, ts TIMESTAMP(6)
);
CREATE VIEW result AS
SELECT id, amount / 3 AS quotient, MOD(amount, 3) AS remainder,
       (amount - MOD(MOD(amount, 86400) + 86400, 86400)) / 86400 AS day_index,
       POSITION(needle IN haystack) AS position,
       SUBSTRING(haystack FROM 4) AS suffix,
       SUBSTRING(haystack FROM 1 FOR 3) AS prefix,
       TIMESTAMPDIFF(SECOND, TIMESTAMP '1970-01-01 00:00:00', ts) AS seconds
FROM scalar_inputs;
