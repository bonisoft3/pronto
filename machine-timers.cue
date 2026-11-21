package pronto

import (
	"list"
	"strings"
)

#TimedMachines: {
	let T = self
	code: _
	out:  [if T.code.state.mecha.rows != _|_ for _, m in T.code.state.mecha.rows if m._timed {m}]
}

// A Mecha machine some state of which starts XState timers (`after`): its
// steps arm the ticker as they enter such a state (mecha-ports.ts), so an
// instance already waiting in one when timers are adopted has no schedule yet.
// Only adoption is checked, before the machine's arm is installed: once a
// timer fired, as XState's one-shot, its state holds none until entered again.
#TimedReducers: {
	let T = self
	code: _
	out:  [if T.code.state.mecha.reducers != _|_ for _, h in T.code.state.mecha.reducers if len([for _, st in h.reducer.states if st.after != _|_ {st}]) > 0 {h.reducer}]
}

#MachineTimerState: {
	let C = self
	code:      _
	_timed:    (#TimedMachines & {code: C.code}).out
	_reducers: (#TimedReducers & {code: C.code}).out
	out: {
		timers: list.Concat([[for m in C._timed {m.name}], [for m in C._reducers {m.name}]])
		if len(timers) > 0 {
			timerCheck: strings.Join(list.Concat([[for m in C._timed {
				(#mechaMachineSql & {machine: m, entities: C.code.state.entities, effects: [if C.code.state.effects != _|_ {C.code.state.effects}, {}][0], signals: [if C.code.state.signals != _|_ {C.code.state.signals}, {}][0], step: (#steps & {code: C.code}).machines})._timerCheck
			}], [for m in C._reducers for sn, st in m.states if st.after != _|_ for delay, _ in st.after {
				"""
					DO $$ BEGIN
					  IF to_regprocedure('hybrid_\(m.name).arm(uuid, bigint, jsonb, bigint)') IS NULL AND EXISTS (SELECT FROM hybrid_\(m.name).instance i WHERE \([if st.initial != _|_ {"starts_with(i.state->>'phase', \((#sqlLit & {v: sn + "."}).out))"}, "i.state->>'phase' = \((#sqlLit & {v: sn}).out)"][0])
					      AND NOT EXISTS (SELECT FROM public.schedule s WHERE s.emits_entity = 'machine_timer_tick'
					        AND s.emits_values @> jsonb_build_object('machine', '\(m.name)', 'row', jsonb_build_object('id', i.id::text), 'state', \((#sqlLit & {v: sn}).out), 'delay', \((#sqlLit & {v: delay}).out)))) THEN
					    RAISE EXCEPTION 'machine \(m.name) has instances in \(sn) whose \(delay) timer the ticker was never given';
					  END IF;
					END $$;
					"""
			}]]), "\n")
		}
	}
}

// Text keys survive the ticker's JSON round trip without losing int64 digits.
#TimerRowSql: {
	let R = self
	pk:  [...string]
	rec: string
	out: "jsonb_build_object(\(strings.Join([for k in R.pk {"'\(strings.Replace(k, "'", "''", -1))', \(R.rec).\"\(k)\"::text"}], ", ")))"
}

#TimerContextSql: {
	let C = self
	machine: string
	field:   string
	pk:      [...string]
	rec:     string
	out: """
		  SELECT t.delay, t.branch INTO timer_delay, timer_branch
		    FROM public.machine_timer_tick t JOIN public.schedule s ON s.name = t.schedule
		    WHERE t.transaction_id = pg_current_xact_id() AND t.branch IS NOT NULL
		      AND t.machine = '\(strings.Replace(C.machine, "'", "''", -1))'
		      AND t."row" = \((#TimerRowSql & {pk: C.pk, rec: C.rec}).out)
		      AND t.state = \(C.rec)."\(C.field)";
		"""
}

// A row machine's time: the transaction's, the same on every read in it, so
// an entry, its actions and the timers it arms agree on it. It is the one
// place a machine reads the clock; a test database replaces it to move time.
#machineClockSql: """
	CREATE OR REPLACE FUNCTION machine_clock() RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = pg_catalog AS $clock$
	SELECT transaction_timestamp();
	$clock$;
	REVOKE ALL ON FUNCTION machine_clock() FROM PUBLIC;
	"""

// The instant a delay entered at `entered_at` is due: milliseconds, or the
// duration the entered row holds, read once as XState reads a delay.
#TimerDueSql: {
	let D = self
	machine: _
	state:   string
	delay:   string
	_value: [if (D.delay & =~"^[0-9]+$") != _|_ {D.delay}, D.machine.delays[D.delay]][0]
	_field: [if (D._value & string) != _|_ if (D._value & =~"^[0-9]+$") == _|_ {D._value}, null][0]
	guard: [if D._field != null {"""
			    IF NEW."\(D._field)" IS NULL THEN
			      RAISE EXCEPTION 'machine % state % waits after %, whose duration % is null', \((#sqlLit & {v: D.machine.name}).out), '\(D.state)', '\(D.delay)', '\(D._field)';
			    END IF;
			"""}, ""][0]
	// The ticker names an instant in milliseconds, so a duration finer than
	// one is due at the next: never earlier than it asks, and an instant a
	// tick can name exactly.
	out: [if D._field != null {"date_trunc('milliseconds', entered_at + NEW.\"\(D._field)\" + interval '999 microseconds')"}, "entered_at + interval '\(D._value) milliseconds'"][0]
}

#MachineTimerSql: {
	let T = self
	machine:      _
	table:        string
	pk:           [...string]
	_m:           T.machine
	_field:       _m.field
	_name:        "'\(strings.Replace(_m.name, "'", "''", -1))'"
	_fn:          "trg_\(T.table)_\(_field)_timer"
	_newKey:      (#TimerRowSql & {pk: T.pk, rec: "NEW"}).out
	_oldKey:      (#TimerRowSql & {pk: T.pk, rec: "OLD"}).out
	_match:       strings.Join([for k in T.pk {"r.\"\(k)\" = (jsonb_populate_record(NULL::\"\(T.table)\", NEW.\"row\")).\"\(k)\""}], " AND ")
	_newMatch:    strings.Join([for k in T.pk {"r.\"\(k)\" = NEW.\"\(k)\""}], " AND ")
	_oldMatch:    strings.Join([for k in T.pk {"r.\"\(k)\" = OLD.\"\(k)\""}], " AND ")
	_updateMatch: strings.Join([for k in T.pk {"r.\"\(k)\" = held.\"\(k)\""}], " AND ")
	_sameKey:     strings.Join([for k in T.pk {"OLD.\"\(k)\" IS NOT DISTINCT FROM NEW.\"\(k)\""}], " AND ")
	_context:     (#TimerContextSql & {machine: _m.name, field: _field, pk: T.pk, rec: "OLD"}).out
	_cancel:      "DELETE FROM public.schedule WHERE emits_entity = 'machine_timer_tick' AND emits_values @> jsonb_build_object('machine', \(_name), 'row', \(_oldKey));"
	_delays:      {for t in _m._timers {(t.state): (t.delay): true}}
	_arms: [for state, delays in _delays {
		"""
			  IF NEW."\(_field)" = '\(state)' THEN
			\(strings.Join([for delay, _ in delays {
				let due = #TimerDueSql & {machine: _m, "state": state, "delay": delay}
				"""
				\(due.guard)
				    INSERT INTO public.schedule (name, due_at, max_lateness_seconds, emits_entity, emits_values)
				      VALUES ('machine:' || gen_random_uuid()::text, \(due.out),
				        2147483647, 'machine_timer_tick', jsonb_build_object('machine', \(_name), 'row', \(_newKey), 'state', '\(state)', 'delay', '\(delay)'));
				"""}], "\n"))
			  END IF;
			"""
	}]
	_adoptionChecks: [for state, delays in _delays for delay, _ in delays {
		let rowKey = (#TimerRowSql & {pk: T.pk, rec: "r"}).out
		"""
			  IF EXISTS (SELECT FROM "\(T.table)" r WHERE r."\(_field)" = '\(state)'
			    AND NOT EXISTS (SELECT FROM public.schedule s WHERE s.emits_entity = 'machine_timer_tick'
			      AND s.due_at IS NOT NULL AND NOT s.suspended AND s.last_tick_at IS NULL
			      AND s.emits_values = jsonb_build_object('machine', \(_name), 'row', \(rowKey), 'state', '\(state)', 'delay', '\(delay)'))) THEN
			    RAISE EXCEPTION 'machine \(_m.name) requires explicit state-entry deadlines for existing rows before timer adoption';
			  END IF;
			"""
	}]
	_guardBranches: [for t in _m._timers {
		let guard = [if t.guard != _|_ {t.guard}, "TRUE"][0]
		"IF OLD.\"\(_field)\" = '\(t.state)' AND delay = '\(t.delay)' AND branch = \(t.branch) THEN RETURN (\(guard)) IS TRUE; END IF;"
	}]
	_choices: [for t in _m._timers {"""
		  IF NEW.state = '\(t.state)' AND NEW.delay = '\(t.delay)' THEN
		    proposed := held;
		    proposed."\(_field)" := '\(t.target)';
		    IF "\(_fn)_guard"(held, proposed, NEW.delay, \(t.branch)) THEN
		      UPDATE public.machine_timer_tick SET branch = \(t.branch) WHERE id = NEW.id;
		      UPDATE "\(T.table)" r SET "\(_field)" = proposed."\(_field)" WHERE \(_updateMatch);
		      DELETE FROM public.schedule WHERE name = NEW.schedule;
		      RETURN NEW;
		    END IF;
		  END IF;
		"""}]

	out: """
		DO $$ BEGIN
		  PERFORM set_config('TimeZone', 'UTC', true);
		  PERFORM set_config('DateStyle', 'ISO, YMD', true);
		  IF to_regprocedure('"\(_fn)_arm"()') IS NULL THEN
		\(strings.Join(_adoptionChecks, "\n"))
		  END IF;
		END $$;

		CREATE OR REPLACE FUNCTION "\(_fn)_guard"(OLD "\(T.table)", NEW "\(T.table)", delay text, branch integer)
		RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
		DECLARE
		  TG_OP constant text := 'UPDATE';
		  TG_TABLE_NAME constant text := '\(T.table)';
		BEGIN
		\(strings.Join(_guardBranches, "\n"))
		  RETURN FALSE;
		END $$;
		REVOKE ALL ON FUNCTION "\(_fn)_guard"("\(T.table)", "\(T.table)", text, integer) FROM PUBLIC;

		CREATE OR REPLACE FUNCTION "\(_fn)_arm"() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
		SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
		DECLARE
		  timer_delay text;
		  timer_branch integer;
		  entered_at timestamptz := date_trunc('milliseconds', machine_clock());
		BEGIN
		  -- A nested AFTER write cannot silently replace the visit being armed.
		  IF TG_OP = 'DELETE' THEN
		    IF EXISTS (SELECT FROM "\(T.table)" r WHERE \(_oldMatch)) THEN
		      RAISE EXCEPTION 'timer owner \(T.table) was recreated by an earlier AFTER trigger';
		    END IF;
		  ELSE
		    IF NOT EXISTS (SELECT FROM "\(T.table)" r WHERE \(_newMatch) AND r.ctid = NEW.ctid) THEN
		      RAISE EXCEPTION 'timer owner \(T.table) changed again in an earlier AFTER trigger';
		    END IF;
		  END IF;
		  IF TG_OP = 'INSERT' THEN
		    DELETE FROM public.schedule WHERE emits_entity = 'machine_timer_tick' AND emits_values @> jsonb_build_object('machine', \(_name), 'row', \(_newKey));
		  END IF;
		  IF TG_OP = 'UPDATE' THEN
		\(_context)
		    IF OLD."\(_field)" IS NOT DISTINCT FROM NEW."\(_field)" AND (\(_sameKey)) AND timer_delay IS NULL THEN RETURN NEW; END IF;
		  END IF;
		  IF TG_OP <> 'INSERT' THEN
		    \(_cancel)
		  END IF;
		  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		\(strings.Join(_arms, "\n"))
		  RETURN NEW;
		END $$;
		REVOKE ALL ON FUNCTION "\(_fn)_arm"() FROM PUBLIC;
		DROP TRIGGER IF EXISTS "\(_fn)_arm" ON "\(T.table)";
		CREATE TRIGGER "\(_fn)_arm" AFTER INSERT OR UPDATE OR DELETE ON "\(T.table)"
		  FOR EACH ROW EXECUTE FUNCTION "\(_fn)_arm"();

		CREATE OR REPLACE FUNCTION "\(_fn)_fire"() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
		SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
		DECLARE held "\(T.table)"; proposed "\(T.table)";
		BEGIN
		  IF NEW.machine <> \(_name) OR NEW.late THEN RETURN NEW; END IF;
		  SELECT r.* INTO held FROM "\(T.table)" r WHERE \(_match) FOR UPDATE;
		  IF NOT FOUND OR held."\(_field)" IS DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
		  -- Lock the owner before rechecking cancellation, as transitions do.
		  -- The tick's instant is the only time a fire reads: the ticker found
		  -- it due.
		  PERFORM 1 FROM public.schedule s WHERE s.name = NEW.schedule AND s.emits_entity = 'machine_timer_tick'
		    AND s.due_at = NEW.tick_at
		    AND s.emits_values = jsonb_build_object('machine', NEW.machine, 'row', NEW."row", 'state', NEW.state, 'delay', NEW.delay);
		  IF NOT FOUND THEN RETURN NEW; END IF;
		\(strings.Join(_choices, "\n"))
		  DELETE FROM public.schedule WHERE name = NEW.schedule;
		  RETURN NEW;
		END $$;
		REVOKE ALL ON FUNCTION "\(_fn)_fire"() FROM PUBLIC;
		DROP TRIGGER IF EXISTS "\(_fn)_fire" ON public.machine_timer_tick;
		CREATE TRIGGER "\(_fn)_fire" AFTER INSERT ON public.machine_timer_tick
		  FOR EACH ROW EXECUTE FUNCTION "\(_fn)_fire"();
		"""
}
