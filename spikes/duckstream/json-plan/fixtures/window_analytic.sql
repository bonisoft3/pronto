CREATE TABLE ordered_hits(id INTEGER NOT NULL, visitor VARCHAR NOT NULL, tick BIGINT NOT NULL);
CREATE VIEW result AS
SELECT id, LAG(tick) OVER (PARTITION BY visitor ORDER BY tick, id) AS previous,
       SUM(tick) OVER (PARTITION BY visitor ORDER BY tick, id ROWS UNBOUNDED PRECEDING) AS total
FROM ordered_hits;
