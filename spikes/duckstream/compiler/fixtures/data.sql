CREATE SCHEMA "schema";
SET schema = 'schema';
CREATE TABLE customers (id INTEGER PRIMARY KEY, region VARCHAR NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount BIGINT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT NOT NULL);
INSERT INTO customers VALUES (1, 'north'), (2, 'south'), (3, 'north');
INSERT INTO orders VALUES (1, 1, 10), (2, 1, 20), (3, 2, 5), (4, 3, 7), (5, 3, -2);
INSERT INTO events VALUES
    (1, '2026-01-01 00:01:00', 10),
    (2, '2026-01-01 00:04:00', 20),
    (3, '2026-01-01 00:06:00', 5);
