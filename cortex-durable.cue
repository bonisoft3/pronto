package pronto

// Durable compositions reuse Mecha's bounded reducer and Durex's durable execution.
// SQL expressions read the accepted `reduced` result and the previous `game` row.
#CortexDurable: {
	machine: #MechaReducerMachine
	invoke: [Phase=string]: {
		task:    string & =~"^[a-z][a-z0-9_]{0,62}$"
		key:     string & !=""
		input:   string & !=""
		onDone:  string
		onError: string
		runAtSql?: string & !=""
		maxAttemptsSql?: string & !=""
	}
}
