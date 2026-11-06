CREATE TABLE instants(id INTEGER NOT NULL, a TIMESTAMP(6) NOT NULL, b TIMESTAMP(6));
CREATE VIEW result AS
SELECT COUNT(*) AS hits, COUNT(DISTINCT id) AS visitors,
       MIN(a) AS first_epoch, MAX(b) AS last_epoch
FROM instants;
