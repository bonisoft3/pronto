CREATE TABLE teams(id UUID NOT NULL, day DATE, rating DOUBLE, score INTEGER, price DECIMAL(18,2));
CREATE TABLE standings(id UUID NOT NULL, position INTEGER);
CREATE VIEW result AS
SELECT t.id, t.day, t.price, t.rating,
       CAST(t.score AS BIGINT) + 2 AS adjusted,
       t.rating * CAST(2 AS DOUBLE) AS doubled,
       CASE WHEN s.position IS NULL THEN 0 ELSE s.position END AS position,
       COALESCE(t.score, 0) AS score
FROM teams t LEFT JOIN standings s ON t.id = s.id;
