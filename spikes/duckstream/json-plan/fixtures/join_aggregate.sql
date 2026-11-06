CREATE TABLE events (id INTEGER NOT NULL PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT);
CREATE TABLE accounts (id INTEGER NOT NULL PRIMARY KEY, region VARCHAR NOT NULL);
CREATE VIEW result AS
SELECT a.region, COUNT(*) AS n, SUM(e.amount) AS total
FROM events e JOIN accounts a ON e.id = a.id
WHERE e.amount > 0
GROUP BY a.region;
