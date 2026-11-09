-- The airlock smoke's machine (tests/airlock_test.ts): one table guarded the
-- way pronto guards an invoking state, and published for the cluster's sync.
-- Entering `charging` claims the ledger and enqueues in the same commit;
-- leaving it takes the ledger's outcome.
CREATE TABLE airlock_smoke (
  id     TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  amount INT NOT NULL
);

CREATE FUNCTION airlock_smoke_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  k text := 'probe:' || NEW.id;
  outcome jsonb;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'charging' THEN
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
    VALUES (k, 'probe', jsonb_build_object('id', NEW.id), jsonb_build_object('amount', NEW.amount))
    ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'external effect % was already performed', k; END IF;
    PERFORM graphile_worker.add_job('external_effect', json_build_object('key', k), job_key => k, max_attempts => 30);
    UPDATE schedule SET due_at = date_trunc('milliseconds', clock_timestamp()), last_tick_at = NULL
     WHERE name = 'airlock' AND last_tick_at IS NOT NULL
       AND name IN (SELECT name FROM schedule WHERE name = 'airlock' FOR UPDATE SKIP LOCKED);
  ELSIF OLD.status = 'charging' THEN
    SELECT l.outcome INTO outcome FROM airlock.external_effect_ledger l WHERE l.key = k;
    IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION '% leaves charging only by its recorded outcome', k;
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER airlock_smoke_guard BEFORE UPDATE ON airlock_smoke
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION airlock_smoke_guard();

INSERT INTO airlock_smoke VALUES ('settles', 'pending', 1250), ('rolls-back', 'pending', 1);

ALTER PUBLICATION electric_publication_default ADD TABLE airlock_smoke;

-- The bridged effect's machine: entering `sending` claims `confirm`, reached
-- through the mail bridge.
CREATE TABLE airlock_smoke_mail (
  id     TEXT PRIMARY KEY,
  status TEXT NOT NULL
);

CREATE FUNCTION airlock_smoke_mail_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  k text := 'confirm:' || NEW.id;
  outcome jsonb;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'sending' THEN
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
    VALUES (k, 'confirm', jsonb_build_object('id', NEW.id), jsonb_build_object('id', NEW.id))
    ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'external effect % was already performed', k; END IF;
    PERFORM graphile_worker.add_job('external_effect', json_build_object('key', k), job_key => k, max_attempts => 30);
  ELSIF OLD.status = 'sending' THEN
    SELECT l.outcome INTO outcome FROM airlock.external_effect_ledger l WHERE l.key = k;
    IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION '% leaves sending only by its recorded outcome', k;
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER airlock_smoke_mail_guard BEFORE UPDATE ON airlock_smoke_mail
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION airlock_smoke_mail_guard();

INSERT INTO airlock_smoke_mail VALUES ('b1', 'pending');
