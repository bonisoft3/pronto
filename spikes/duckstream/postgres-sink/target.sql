CREATE TABLE authoritative (
    id INTEGER PRIMARY KEY,
    version BIGINT NOT NULL,
    value BIGINT,
    deleted BOOLEAN NOT NULL
);
CREATE TABLE guarded (LIKE authoritative INCLUDING ALL);
CREATE TABLE write_audit (
    sequence BIGSERIAL PRIMARY KEY,
    target TEXT NOT NULL,
    operation TEXT NOT NULL,
    id INTEGER NOT NULL,
    old_version BIGINT,
    new_version BIGINT,
    old_deleted BOOLEAN,
    new_deleted BOOLEAN
);
CREATE FUNCTION audit_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO write_audit(target, operation, id, old_version, new_version, old_deleted, new_deleted)
    VALUES (TG_TABLE_NAME, TG_OP, COALESCE(NEW.id, OLD.id), OLD.version, NEW.version, OLD.deleted, NEW.deleted);
    RETURN NULL;
END;
$$;
CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON authoritative
FOR EACH ROW EXECUTE FUNCTION audit_write();
CREATE TRIGGER audit_write AFTER INSERT OR UPDATE OR DELETE ON guarded
FOR EACH ROW EXECUTE FUNCTION audit_write();

CREATE FUNCTION guard_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    current_row guarded%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'physical deletes discard the version barrier';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id <> OLD.id THEN
            RAISE EXCEPTION 'authoritative keys are immutable';
        END IF;
        current_row := OLD;
    ELSE
        SELECT * INTO current_row FROM guarded WHERE id = NEW.id;
    END IF;
    IF current_row.id IS NOT NULL THEN
        IF NEW.version < current_row.version THEN
            RETURN NULL;
        END IF;
        IF NEW.version = current_row.version THEN
            IF (NEW.value, NEW.deleted) IS DISTINCT FROM (current_row.value, current_row.deleted) THEN
                RAISE EXCEPTION 'conflicting payload for key %, version %', NEW.id, NEW.version;
            END IF;
            RETURN NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER guard_version BEFORE INSERT OR UPDATE OR DELETE ON guarded
FOR EACH ROW EXECUTE FUNCTION guard_version();
