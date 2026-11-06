CREATE TABLE metrics(g INTEGER, value DOUBLE, exact_value DECIMAL(18,2));
CREATE VIEW result AS
SELECT g, MIN(value) AS low, MAX(value) AS high, AVG(value) AS mean,
       MIN(exact_value) AS exact_low, MAX(exact_value) AS exact_high
FROM metrics GROUP BY g;
