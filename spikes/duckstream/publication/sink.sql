CREATE SCHEMA source;
CREATE TABLE source.items (id integer PRIMARY KEY, value integer NOT NULL);
ALTER TABLE source.items REPLICA IDENTITY FULL;
CREATE TABLE outputs (
    output_key integer PRIMARY KEY,
    input_version bigint NOT NULL,
    value integer NOT NULL,
    deleted boolean NOT NULL
);
CREATE VIEW visible_outputs AS SELECT output_key, value FROM outputs WHERE NOT deleted;
CREATE TABLE receipts (identity text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE effects (ordinal bigint GENERATED ALWAYS AS IDENTITY, output_key integer, input_version bigint);
CREATE FUNCTION audit_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO effects(output_key, input_version) VALUES (NEW.output_key, NEW.input_version);
    RETURN NEW;
END;
$$;
CREATE TRIGGER output_effect AFTER INSERT OR UPDATE ON outputs
FOR EACH ROW EXECUTE FUNCTION audit_output();
CREATE FUNCTION publish(identity_arg text, payload_arg jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    prior jsonb;
    item record;
    previous outputs%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(91832641);
    IF payload_arg->>'scope' IS DISTINCT FROM 'double/v1/source-1' THEN
        RAISE EXCEPTION 'unauthorized scope';
    END IF;
    IF jsonb_typeof(payload_arg->'rows') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'rows array required';
    END IF;
    SELECT payload INTO prior FROM receipts WHERE identity = identity_arg;
    IF FOUND THEN
        IF prior <> payload_arg THEN RAISE EXCEPTION 'conflicting publication identity'; END IF;
        RETURN 'duplicate';
    END IF;
    IF (SELECT count(*) <> count(DISTINCT output_key)
        FROM jsonb_to_recordset(payload_arg->'rows')
            AS r(output_key integer, input_version bigint, value integer, deleted boolean)) THEN
        RAISE EXCEPTION 'duplicate publication key';
    END IF;
    FOR item IN SELECT * FROM jsonb_to_recordset(payload_arg->'rows')
        AS r(output_key integer, input_version bigint, value integer, deleted boolean)
    LOOP
        IF item.output_key IS NULL OR item.input_version IS NULL OR item.input_version <= 0
            OR item.value IS NULL OR item.deleted IS NULL THEN
            RAISE EXCEPTION 'complete positive-version result required';
        END IF;
        SELECT * INTO previous FROM outputs WHERE output_key = item.output_key;
        IF FOUND AND previous.input_version = item.input_version AND
            (previous.value IS DISTINCT FROM item.value OR previous.deleted IS DISTINCT FROM item.deleted) THEN
            RAISE EXCEPTION 'conflicting output version';
        END IF;
        INSERT INTO outputs VALUES (item.output_key, item.input_version, item.value, item.deleted)
        ON CONFLICT (output_key) DO UPDATE SET
            input_version = EXCLUDED.input_version,
            value = EXCLUDED.value,
            deleted = EXCLUDED.deleted
        WHERE outputs.input_version < EXCLUDED.input_version;
    END LOOP;
    INSERT INTO receipts VALUES (identity_arg, payload_arg);
    RETURN 'committed';
END;
$$;
