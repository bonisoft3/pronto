CREATE TABLE instants(id INTEGER NOT NULL, a TIMESTAMP(6) NOT NULL, b TIMESTAMP(6));
CREATE LOCAL VIEW shifted AS
SELECT id, a, b, a + INTERVAL '1860' SECOND AS next_epoch FROM instants;
CREATE VIEW result AS
SELECT id, next_epoch, TIMESTAMPDIFF(SECOND, a, b) AS seconds,
       CAST('tick' AS VARCHAR) || CAST(id AS VARCHAR) AS label
FROM shifted;
