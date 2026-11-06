CREATE TABLE account (id INTEGER PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE event (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account,
                    amount INTEGER NOT NULL, happened TIMESTAMP NOT NULL, revision INTEGER NOT NULL);
ALTER TABLE account REPLICA IDENTITY FULL;
ALTER TABLE event REPLICA IDENTITY FULL;
CREATE PUBLICATION duckstream FOR TABLE account, event;
INSERT INTO account VALUES (1, 'a', 0), (2, 'b', 0);
INSERT INTO event VALUES (1, 1, 10, '2026-01-01 00:00:00', 0),
                         (2, 1, 20, '2026-01-01 00:00:04.999', 0),
                         (3, 2, 30, '2026-01-01 00:00:05', 0);
