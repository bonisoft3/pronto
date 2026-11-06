CREATE TABLE customers (id INTEGER NOT NULL PRIMARY KEY, region VARCHAR NOT NULL);
CREATE TABLE orders (id INTEGER NOT NULL PRIMARY KEY, customer_id INTEGER NOT NULL, amount BIGINT NOT NULL);
CREATE VIEW result AS
SELECT c.region, COUNT(*) AS order_count, SUM(o.amount) AS total
FROM orders o JOIN customers c ON o.customer_id = c.id
WHERE o.amount > 0
GROUP BY c.region;
